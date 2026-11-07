import { useEffect, useState } from 'react';
import { api } from '../api';
import { clock } from '../format';

type Audit = { action: string; targetId: string; reason: string | null; serverTime: string; actorRole: string };

export function ActivityScreen() {
  const [audits, setAudits] = useState<Audit[]>([]);
  const [health, setHealth] = useState<Record<string, string | number | boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([api<{ audits: Audit[] }>('/api/views/activity'), api<Record<string, string | number | boolean>>('/api/health')])
      .then(([activity, status]) => {
        setAudits(activity.audits);
        setHealth(status);
      })
      .catch(() => setError('Activity could not be loaded.'));
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="muted">Audit of commands, not a claim about outcomes in a real shelter</p>
          <h1>What the record shows.</h1>
        </div>
      </div>
      {error ? <div className="banner" role="alert">{error}</div> : null}
      <section className="panel" style={{ padding: 16 }}>
        <h2>This environment</h2>
        <ul>
          <li>Backend: local authority implementing the blueprint reducers. SpacetimeDB is not connected.</li>
          <li>Nemotron: {health?.nemotron === 'configured' ? 'an endpoint is configured' : 'unavailable. Deterministic planning remains usable.'}</li>
          <li>Serial board: {health?.serial === 'connected' ? 'connected' : 'not attached. On-screen confirm uses the same local save.'}</li>
          <li>Pending local requests: {String(health?.pendingLocal ?? '…')}</li>
        </ul>
        <p className="footer-note">Physical power-loss, a live sponsor database, and a recorded Nemotron tool trace are not claimed by this screen.</p>
      </section>
      {!audits.length && !error ? <p>Loading activity…</p> : null}
      <ol className="timeline">
        {audits.map((audit) => (
          <li key={`${audit.serverTime}-${audit.action}-${audit.targetId}`}>
            <strong>{audit.action}</strong> by {audit.actorRole} · {clock(audit.serverTime)}
            <div className="muted">{audit.targetId}{audit.reason ? ` · ${audit.reason}` : ''}</div>
          </li>
        ))}
      </ol>
    </main>
  );
}
