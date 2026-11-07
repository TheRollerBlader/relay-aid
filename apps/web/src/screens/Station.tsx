import { useEffect, useState } from 'react';
import { api, ApiError, commandId } from '../api';
import { clock, freshness, shortRef } from '../format';

type StationView = {
  selectedNeed: 'WATER' | 'CHARGING';
  uplink: boolean;
  serial: string;
  pendingCount: number;
  serverTime: string;
  focus: Card | null;
  requests: Card[];
};

type Card = {
  requestId: string;
  shortRef: string;
  needType: 'WATER' | 'CHARGING';
  source: string;
  code: string;
  copy: { title: string; detail: string; pattern: string; tone: string };
  createdAt: string;
  lastError: string | null;
  server: { version: string; state: string } | null;
};

export function StationScreen() {
  const [view, setView] = useState<StationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const body = await api<StationView>('/api/station');
      setView(body);
      setError(null);
      setLoadedAt(Date.now());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Station unavailable.');
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement) return;
      if (event.key === '1') void select('WATER');
      if (event.key === '2') void select('CHARGING');
      if (event.key === 'Enter') {
        event.preventDefault();
        void confirm('keyboard');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function select(need: 'WATER' | 'CHARGING') {
    const body = await api<StationView>('/api/station/selection', { method: 'POST', body: JSON.stringify({ need }) });
    setView(body);
  }

  async function confirm(source: 'pointer' | 'keyboard') {
    setBusy(true);
    try {
      const body = await api<{ station: StationView; saved: boolean }>('/api/station/confirm', {
        method: 'POST',
        body: JSON.stringify({ source, commandId: commandId() }),
      });
      setView(body.station);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Not saved.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  const focus = view?.focus;
  return (
    <main className="home station">
      <div className="page-head">
        <div>
          <p className="muted">Lobby station · {freshness(loadedAt)}</p>
          <h1>Water or a charge.</h1>
        </div>
      </div>
      <p>Select a need, then confirm. Selection alone does not create a request. Keys: 1 water, 2 charging, Enter confirm.</p>
      {error ? <div className="banner" role="alert">{error}</div> : null}
      {!view?.uplink ? <div className="banner warn">Uplink is paused. A confirm can be saved on this laptop, and it will say so. It is not delivered.</div> : null}
      <div className="choices">
        <button type="button" className="choice" aria-pressed={view?.selectedNeed === 'WATER'} onClick={() => void select('WATER')}>
          <span className="muted">Need</span>
          <strong style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: '2rem' }}>Water</strong>
          <span>One bottle from stock. Stock is consumed when staff complete it.</span>
        </button>
        <button type="button" className="choice" aria-pressed={view?.selectedNeed === 'CHARGING'} onClick={() => void select('CHARGING')}>
          <span className="muted">Need</span>
          <strong style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: '2rem' }}>Charging</strong>
          <span>One staffed outlet. The slot is released when staff complete it.</span>
        </button>
      </div>
      <button type="button" className="primary" style={{ minHeight: 64, fontSize: '1.15rem' }} disabled={busy || !view} onClick={() => void confirm('pointer')}>
        {busy ? 'Saving…' : `Confirm ${view?.selectedNeed === 'CHARGING' ? 'charging' : 'water'} request`}
      </button>
      <section className="status-card" aria-live="polite">
        <p className="muted">Latest request {focus ? shortRef(focus.requestId, focus.needType) : ''}</p>
        <h2 style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <i className={`swatch swatch-${focus?.copy.pattern ?? 'off'} tone-${focus?.copy.tone ?? 'neutral'}`} aria-hidden />
          {focus?.copy.title ?? 'Select a need, then confirm'}
        </h2>
        <p>{focus?.copy.detail ?? 'Nothing is submitted until you confirm.'}</p>
        <p><strong>{view?.pendingCount ?? 0}</strong> still waiting to be delivered. A green mark on one request does not clear the others.</p>
        {focus ? <p className="muted">Input used: {focus.source}. Full id {focus.requestId}. Saved at {clock(focus.createdAt)}.</p> : null}
      </section>
      <div className="legend" aria-label="Status legend">
        <div><i className="swatch swatch-pulse tone-amber" aria-hidden /> Saved here, not delivered</div>
        <div><i className="swatch swatch-steady tone-amber" aria-hidden /> Delivered, waiting for a person</div>
        <div><i className="swatch swatch-steady tone-blue" aria-hidden /> Coordinator acknowledged</div>
        <div><i className="swatch swatch-steady tone-green" aria-hidden /> Marked complete by staff</div>
      </div>
      <details className="panel" style={{ padding: 16 }}>
        <summary>Operator panel</summary>
        <p>Storage is healthy. Serial link: {view?.serial === 'connected' ? 'board connected' : 'no board, on-screen buttons use the same save function'}. Server: {error ? 'not answering' : 'answering'}.</p>
        <button
          type="button"
          className="secondary"
          onClick={() => void api('/api/station/uplink', { method: 'POST', body: JSON.stringify({ connected: !view?.uplink }) }).then(load)}
        >
          {view?.uplink ? 'Pause uplink' : 'Reconnect uplink'}
        </button>
        {view?.requests.some((request) => request.lastError) ? (
          <ul>
            {view.requests.filter((request) => request.lastError).map((request) => (
              <li key={request.requestId}>{request.shortRef}: {request.lastError}</li>
            ))}
          </ul>
        ) : <p className="muted">No sync errors.</p>}
      </details>
      <ul className="list">
        {(view?.requests ?? []).map((request) => (
          <li key={request.requestId} className="row" style={{ display: 'grid' }}>
            <strong>{request.shortRef}</strong>
            <span>{request.copy.title}</span>
            <span className="muted">{request.needType === 'WATER' ? 'Water' : 'Charging'}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
