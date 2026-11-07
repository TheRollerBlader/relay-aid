import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api';
import { ActivityScreen } from './screens/Activity';
import { HomeScreen } from './screens/Home';
import { ProposalsScreen } from './screens/Proposals';
import { QueueScreen } from './screens/Queue';
import { ResourcesScreen } from './screens/Resources';
import { StationScreen } from './screens/Station';
import { VolunteerScreen } from './screens/Volunteer';

type Role = 'station' | 'coordinator' | 'volunteer' | 'admin' | null;

const SessionContext = createContext<{ role: Role; refresh: () => Promise<void>; choose: (role: Exclude<Role, null>) => Promise<void> }>({
  role: null,
  refresh: async () => undefined,
  choose: async () => undefined,
});

export function useSession() {
  return useContext(SessionContext);
}

export function App() {
  const [role, setRole] = useState<Role>(null);
  const [ready, setReady] = useState(false);
  async function refresh() {
    const body = await api<{ role: Role }>('/api/session');
    setRole(body.role);
    setReady(true);
  }
  async function choose(next: Exclude<Role, null>) {
    await api('/api/session', { method: 'POST', body: JSON.stringify({ role: next }) });
    setRole(next);
  }
  useEffect(() => {
    void refresh().catch(() => setReady(true));
  }, []);
  return (
    <SessionContext.Provider value={{ role, refresh, choose }}>
      <div className="app-shell">
        <header className="topbar">
          <Link className="brand" to="/">
            <span className="mark" aria-hidden>R</span>
            <span>
              <strong>RelayAid</strong>
              <small style={{ display: 'block' }}>North Hall Shelter · synthetic exercise</small>
            </span>
          </Link>
          <div className="role-switch">
            <RoleButton role="station" label="Station" />
            <RoleButton role="coordinator" label="Coordinator" />
            <RoleButton role="volunteer" label="Volunteer" />
          </div>
        </header>
        {!ready ? <p className="home">Checking the shelter record…</p> : <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/station" element={<Need role="station"><StationScreen /></Need>} />
          <Route path="/coord" element={<Need role="coordinator"><Shell><QueueScreen /></Shell></Need>} />
          <Route path="/coord/resources" element={<Need role="coordinator"><Shell><ResourcesScreen /></Shell></Need>} />
          <Route path="/coord/proposals" element={<Need role="coordinator"><Shell><ProposalsScreen /></Shell></Need>} />
          <Route path="/coord/activity" element={<Need role="coordinator"><Shell><ActivityScreen /></Shell></Need>} />
          <Route path="/volunteer" element={<Need role="volunteer"><VolunteerScreen /></Need>} />
        </Routes>}
      </div>
    </SessionContext.Provider>
  );
}

function RoleButton({ role, label }: { role: Exclude<Role, null>; label: string }) {
  const session = useSession();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={session.role === role ? 'primary' : 'ghost'}
      aria-pressed={session.role === role}
      onClick={() => {
        void session.choose(role).then(() => {
          if (role === 'station') navigate('/station');
          if (role === 'coordinator') navigate('/coord');
          if (role === 'volunteer') navigate('/volunteer');
        });
      }}
    >
      {label}
    </button>
  );
}

function Need({ role, children }: { role: Exclude<Role, null>; children: ReactNode }) {
  const session = useSession();
  if (session.role !== role && !(role === 'coordinator' && session.role === 'admin')) {
    return (
      <main className="home">
        <h1>This desk is for the {role}.</h1>
        <p>Switch role in the header. The server still checks that identity on every action.</p>
      </main>
    );
  }
  return children;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="layout">
      <nav className="rail" aria-label="Coordinator">
        <NavLink to="/coord" end>Queue</NavLink>
        <NavLink to="/coord/resources">Resources</NavLink>
        <NavLink to="/coord/proposals">Proposals</NavLink>
        <NavLink to="/coord/activity">Activity</NavLink>
      </nav>
      <div>{children}</div>
    </div>
  );
}
