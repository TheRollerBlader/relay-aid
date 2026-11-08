import { useMemo } from 'react'
import { AuthProvider, useAuth } from 'react-oidc-context'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { SpacetimeDBProvider } from 'spacetimedb/react'
import { RoleGate } from './components/RoleGate'
import { Shell } from './components/Shell'
import { DbConnection } from './module_bindings/index.ts'
import { demoMode, oidcAuthority, oidcClientId, spacetimeDb, spacetimeEnabled, spacetimeUri } from './lib/config.ts'
import { bindOutbox } from './lib/outboxClient.ts'
import { readToken, saveToken, setLink, setOwner } from './lib/session.ts'
import { AccessView } from './views/AccessView'
import { HomeView } from './views/HomeView'
import { JoinView } from './views/JoinView'
import { PlanDetailView } from './views/PlanDetailView'
import { AidView } from './views/AidView'
import { BoardView } from './views/BoardView'
import { PlansView } from './views/PlansView'
import { QueueView } from './views/QueueView'
import { ReceiptView } from './views/ReceiptView'
import { RequestDetailView } from './views/RequestDetailView'
import { RequestView } from './views/RequestView'
import { RequestsView } from './views/RequestsView'
import { ResourcesView } from './views/ResourcesView'
import { TaskDetailView } from './views/TaskDetailView'
import { TasksView } from './views/TasksView'
import { TimelineView } from './views/TimelineView'
import { OutboxSync } from './views/OutboxSync'

function DeskRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<HomeView />} />
          <Route path="access" element={<AccessView />} />
          <Route path="join/:inviteId" element={<JoinView />} />
          <Route element={<RoleGate role="resident" />}>
            <Route element={<OutboxSync />}>
              <Route path="r/request" element={<RequestView />} />
              <Route path="r/requests" element={<RequestsView />} />
              <Route path="r/requests/:clientRequestId" element={<ReceiptView />} />
            </Route>
          </Route>
          <Route element={<RoleGate role="coordinator" />}>
            <Route path="c/queue" element={<QueueView />} />
            <Route path="c/board" element={<BoardView />} />
            <Route path="c/aid" element={<AidView />} />
            <Route path="c/requests/:requestPk" element={<RequestDetailView />} />
            <Route path="c/resources" element={<ResourcesView />} />
            <Route path="c/plans" element={<PlansView />} />
            <Route path="c/plans/:planId" element={<PlanDetailView />} />
            <Route path="c/timeline" element={<TimelineView />} />
          </Route>
          <Route element={<RoleGate role="volunteer" />}>
            <Route path="v/tasks" element={<TasksView />} />
            <Route path="v/tasks/:assignmentId" element={<TaskDetailView />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

function DeskApp({ tokenProvider }: { tokenProvider?: () => Promise<string> }) {
  const connectionBuilder = useMemo(() => {
    let builder = DbConnection.builder()
      .withUri(spacetimeEnabled ? spacetimeUri : 'ws://127.0.0.1:9')
      .withDatabaseName(spacetimeDb || 'relayaid-demo')
      .onConnect((_connection, identity, token) => {
        if (demoMode) saveToken(token)
        const owner = identity.toHexString()
        setOwner(owner)
        void bindOutbox(owner, localStorage.getItem('relayaid-shelter') || 'shelter-a')
        setLink('online')
      })
      .onAutomaticReconnect((_connection, identity, token) => {
        if (demoMode) saveToken(token)
        const owner = identity.toHexString()
        setOwner(owner)
        void bindOutbox(owner, localStorage.getItem('relayaid-shelter') || 'shelter-a')
        setLink('online')
      })
      .onConnectError(() => setLink('offline'))
      .onDisconnect((_ctx, _error, attempt) => setLink(attempt ? 'reconnecting' : 'offline'))
    if (spacetimeEnabled) builder = builder.withAutomaticReconnect()
    if (tokenProvider) return builder.withTokenProvider(tokenProvider)
    return builder.withToken(readToken())
  }, [tokenProvider])

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <DeskRoutes />
    </SpacetimeDBProvider>
  )
}

function RealApp() {
  const auth = useAuth()
  const token = auth.user?.id_token
  const tokenProvider = useMemo(() => {
    if (!token) return undefined
    return async () => token
  }, [token])

  if (auth.isLoading) return <p className="p-8 text-muted">Connecting to sign-in…</p>
  if (auth.error) return <p className="p-8">Sign-in did not finish. Try again.</p>
  if (!auth.isAuthenticated || !tokenProvider) {
    return (
      <main className="mx-auto max-w-xl px-5 py-16">
        <p className="font-mono text-[11px] tracking-[0.18em] text-accent">SIGN IN</p>
        <h1 className="mt-3 text-4xl font-medium">Sign in to the shelter desk</h1>
        <p className="mt-4 text-muted">
          Verification mail stays in the local inbox. It is not sent to a real mailbox. After you register, open that inbox and use the newest verification message.
        </p>
        <a href="http://localhost:8025" className="mt-3 inline-flex min-h-12 items-center text-accent">
          Open local inbox
        </a>
        <button type="button" className="mt-6 min-h-12 border border-accent px-4" onClick={() => void auth.signinRedirect()}>
          Sign in
        </button>
      </main>
    )
  }

  return <DeskApp tokenProvider={tokenProvider} />
}

function SignInMissing() {
  return (
    <main className="mx-auto max-w-xl px-5 py-16">
      <h1 className="text-4xl font-medium">Sign-in is not configured</h1>
      <p className="mt-4 text-muted">Set VITE_OIDC_CLIENT_ID before turning off demo mode. This desk will not open an anonymous connection.</p>
    </main>
  )
}

export default function App() {
  if (!demoMode && !oidcClientId) return <SignInMissing />
  if (!demoMode) {
    return (
      <AuthProvider
        authority={oidcAuthority}
        client_id={oidcClientId}
        redirect_uri={window.location.origin}
        response_type="code"
        scope="openid profile email"
        onSigninCallback={() => {
          window.history.replaceState({}, document.title, window.location.pathname)
        }}
      >
        <RealApp />
      </AuthProvider>
    )
  }
  return <DeskApp />
}
