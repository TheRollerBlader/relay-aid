import { useEffect, useState } from 'react';
import { api, ApiError, commandId } from '../api';
import { clock, freshness, shortRef, waitLabel } from '../format';

type Filter = 'NEW' | 'ACKNOWLEDGED' | 'UNMATCHED' | 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';

type QueueRequest = {
  requestId: string;
  needType: 'WATER' | 'CHARGING';
  state: string;
  version: string;
  receivedAt: string;
  deviceCreatedAt: string;
  zoneId: string;
  requiresStepFree: boolean;
  stationLabel: string;
  assignmentId: string | null;
  assignmentVersion: string | null;
  resourceLabel: string | null;
  unmatchedReason: string | null;
  unmatchedDetail: string | null;
  events: Array<{ kind: string; version: string; serverTime: string; reasonCode: string | null }>;
};

type QueueBody = {
  shelterName: string;
  allocationEpoch: string;
  serverTime: string;
  counts: Record<Filter, number>;
  requests: QueueRequest[];
};

type Resource = { resourceId: string; label: string; needType: string; freeUnits: number; available: boolean; stepFree: boolean; version: string };

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'NEW', label: 'Unacknowledged' },
  { id: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { id: 'UNMATCHED', label: 'Unmatched' },
  { id: 'ASSIGNED', label: 'Assigned' },
  { id: 'COMPLETED', label: 'Completed' },
  { id: 'CANCELLED', label: 'Cancelled' },
];

export function QueueScreen() {
  const [data, setData] = useState<QueueBody | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [filter, setFilter] = useState<Filter>('NEW');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [resourceId, setResourceId] = useState('');
  const [reason, setReason] = useState('Coordinator review');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [queue, inventory] = await Promise.all([
        api<QueueBody>('/api/views/queue'),
        api<{ resources: Resource[] }>('/api/views/resources'),
      ]);
      setData(queue);
      setResources(inventory.resources);
      setError(null);
      setLoadedAt(Date.now());
      setSelected((current) => current ?? queue.requests.find((request) => request.state === 'NEW')?.requestId ?? queue.requests[0]?.requestId ?? null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Queue unavailable.');
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 2000);
    return () => clearInterval(id);
  }, []);

  const visible = (data?.requests ?? []).filter((request) => {
    if (filter === 'UNMATCHED') return request.state === 'ACKNOWLEDGED' && request.unmatchedReason;
    return request.state === filter;
  });
  const current = data?.requests.find((request) => request.requestId === selected) ?? visible[0] ?? null;
  const options = resources.filter((resource) => current && resource.needType === current.needType && resource.available && resource.freeUnits > 0 && (!current.requiresStepFree || resource.stepFree));

  async function act(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.errorCode ?? 'Error'}: ${caught.message}` : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="muted">{data?.shelterName ?? 'Shelter'} · epoch {data?.allocationEpoch ?? '…'} · {freshness(loadedAt)}</p>
          <h1>Unacknowledged work stays on this list.</h1>
        </div>
      </div>
      {error ? <div className="banner" role="alert">{error}</div> : null}
      <div className="filters" role="tablist">
        {FILTERS.map((item) => (
          <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label} <span>{data?.counts[item.id] ?? 0}</span>
          </button>
        ))}
      </div>
      {!data ? <p>Loading the queue…</p> : null}
      {data && visible.length === 0 ? <div className="banner info">No requests in {FILTERS.find((item) => item.id === filter)?.label}. Other filters may still have work. The queue is not empty just because this one is.</div> : null}
      <div className="split">
        <div className="list">
          {visible.map((request) => (
            <button key={request.requestId} type="button" className="row" aria-pressed={current?.requestId === request.requestId} onClick={() => setSelected(request.requestId)}>
              <strong>{shortRef(request.requestId, request.needType)}</strong>
              <span>
                {request.needType === 'WATER' ? 'Water' : 'Charging'} · {request.stationLabel} · {request.zoneId}
                <br />
                <span className="muted">{waitLabel(request.receivedAt, data?.serverTime ?? request.receivedAt)}</span>
              </span>
              <span>{request.state}{request.unmatchedReason ? ` · ${request.unmatchedReason}` : ''}</span>
            </button>
          ))}
        </div>
        <aside className="detail">
          {!current ? <p>Select a request.</p> : <>
            <p className="muted">Version {current.version}</p>
            <h2>{shortRef(current.requestId, current.needType)} · {current.needType === 'WATER' ? 'Water' : 'Charging'}</h2>
            <p>{current.state === 'NEW' ? 'Waiting for a person to acknowledge it.' : current.state === 'ACKNOWLEDGED' ? 'Acknowledged. No assignment yet.' : current.state === 'ASSIGNED' ? `Assignment approved${current.resourceLabel ? `: ${current.resourceLabel}` : ''}. Completion is still pending.` : current.state}</p>
            {current.unmatchedDetail ? <p>{current.unmatchedDetail}</p> : null}
            <p className="muted">Server received {clock(current.receivedAt)}. Station clock, unverified: {clock(current.deviceCreatedAt)}.</p>
            <p className="muted">Full id {current.requestId}</p>
            <ol className="timeline">
              {current.events.map((event) => (
                <li key={`${event.kind}-${event.version}`}>{event.kind} · v{event.version} · {clock(event.serverTime)}{event.reasonCode ? ` · ${event.reasonCode}` : ''}</li>
              ))}
            </ol>
            <div className="actions">
              {current.state === 'NEW' ? <button type="button" className="primary" disabled={busy} onClick={() => void act('/api/commands/acknowledge', { requestId: current.requestId, expectedVersion: current.version, commandId: commandId() })}>Acknowledge</button> : null}
              {current.state === 'ACKNOWLEDGED' ? <>
                <label htmlFor="manual-resource">
                  Resource for a one-item plan
                  <select id="manual-resource" name="resourceId" value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
                    <option value="">Choose a resource</option>
                    {options.map((resource) => <option key={resource.resourceId} value={resource.resourceId}>{resource.label} · {resource.freeUnits} free</option>)}
                  </select>
                </label>
                <button type="button" className="primary" disabled={busy || !resourceId} onClick={() => void act('/api/commands/manual-plan', { requestId: current.requestId, resourceId, expectedRequestVersion: current.version, commandId: commandId() })}>Create one-item plan</button>
                <button type="button" className="ghost" disabled={busy} onClick={() => void act('/api/commands/requirements', { requestId: current.requestId, expectedVersion: current.version, requiresStepFree: !current.requiresStepFree, reason, commandId: commandId() })}>
                  {current.requiresStepFree ? 'Clear step-free need' : 'Confirm step-free need'}
                </button>
              </> : null}
              {current.state === 'ASSIGNED' && current.assignmentId ? <>
                <button type="button" className="ghost" disabled={busy} onClick={() => void act('/api/commands/attach', { assignmentId: current.assignmentId, volunteerIdentity: 'identity-volunteer', expectedAssignmentVersion: current.assignmentVersion, commandId: commandId() })}>Attach Volunteer North</button>
                <button type="button" className="primary" disabled={busy} onClick={() => void act('/api/commands/complete', { assignmentId: current.assignmentId, expectedAssignmentVersion: current.assignmentVersion, expectedRequestVersion: current.version, commandId: commandId() })}>Mark complete</button>
              </> : null}
              {current.state !== 'COMPLETED' && current.state !== 'CANCELLED' ? <>
                <label htmlFor="cancel-reason">Reason
                  <input id="cancel-reason" name="reason" value={reason} onChange={(event) => setReason(event.target.value)} />
                </label>
                <button type="button" className="secondary" disabled={busy} onClick={() => void act('/api/commands/cancel', { requestId: current.requestId, expectedVersion: current.version, reason, commandId: commandId() })}>Cancel request</button>
              </> : null}
              {(current.state === 'COMPLETED' || current.state === 'CANCELLED') ? <button type="button" className="ghost" disabled={busy} onClick={() => void act('/api/commands/linked', { requestId: current.requestId, reason, commandId: commandId() })}>Open a new linked request</button> : null}
            </div>
          </>}
        </aside>
      </div>
    </main>
  );
}
