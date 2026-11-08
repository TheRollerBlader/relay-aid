import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { primaryButton } from '../components/Dialog'
import { ErrorBanner } from '../components/ErrorBanner'
import { demoMode, homeFor, roleLabels, SHELTERS, spacetimeEnabled, type DemoRole, type ShelterId } from '../lib/config'
import { setDemoRole, setShelter, useSession } from '../lib/session'
import { runReducer, useConnection } from '../lib/server'

const ROLES: DemoRole[] = ['resident', 'coordinator', 'volunteer']

export function HomeView() {
  const session = useSession()
  const connection = useConnection()
  const navigate = useNavigate()
  const [pending, setPending] = useState<DemoRole | null>(null)
  const [hall, setHall] = useState<ShelterId>(session.shelterId)
  const [error, setError] = useState<string | null>(null)

  async function claim(role: DemoRole) {
    setError(null)
    setPending(role)
    setShelter(hall)
    if (!spacetimeEnabled || !connection) {
      setDemoRole(role)
      setPending(null)
      navigate(homeFor(role))
      return
    }
    const result = await runReducer(connection, (current) =>
      current.reducers.claimDemoRole({
        shelterId: hall,
        role,
        displayLabel: roleLabels[role],
      }),
    )
    setPending(null)
    if (!result.ok) {
      setError(result.text)
      if (result.code === 'UNAUTHORIZED' || result.code === 'WRONG_SHELTER') navigate('/access')
      return
    }
    setDemoRole(role)
    navigate(homeFor(role))
  }

  return (
    <div className="max-w-xl">
      <p className="font-mono text-[11px] tracking-[0.18em] text-accent">
        {SHELTERS.find((item) => item.id === hall)?.name ?? 'SHELTER'}
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {SHELTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={session.role !== null}
            onClick={() => setHall(item.id)}
            className={hall === item.id ? 'min-h-12 border border-accent px-4 text-sm' : 'min-h-12 border border-line px-4 text-sm text-muted'}
          >
            {item.name}
          </button>
        ))}
      </div>
      <h1 className="mt-3 text-4xl font-medium tracking-tight">{demoMode ? 'Choose a desk' : 'Shelter desk'}</h1>
      <p className="mt-3 text-muted">
        {demoMode
          ? 'This browser keeps one role. A second role needs another browser profile. Clear this device starts a new identity and leaves the old one on the server. This is not real authentication.'
          : 'Open the invite link from a coordinator. The shelter assigns resident or volunteer. Staff desks are granted separately.'}
      </p>
      {session.role && (
        <p className="mt-6 border border-line bg-panel px-4 py-3 text-sm">
          This browser is the {session.role}.{' '}
          <Link to={homeFor(session.role)} className="text-accent">
            Continue
          </Link>
        </p>
      )}
      {error && (
        <div className="mt-6">
          <ErrorBanner title="Not claimed" text={error} />
        </div>
      )}
      {demoMode && (
      <div className="mt-6 grid gap-3">
        {ROLES.map((role) => (
          <button
            key={role}
            type="button"
            disabled={pending !== null || session.role !== null || (spacetimeEnabled && !connection)}
            onClick={() => void claim(role)}
            className={`${primaryButton} capitalize`}
          >
            {pending === role ? 'Claiming…' : role}
          </button>
        ))}
      </div>
      )}
    </div>
  )
}
