import { useEffect, useState } from 'react';
import { api, ApiError, commandId } from '../api';

type Resource = {
  resourceId: string;
  label: string;
  needType: string;
  accountingMode: string;
  totalCapacity: number;
  reservedUnits: number;
  consumedUnits: number;
  freeUnits: number;
  available: boolean;
  stepFree: boolean;
  zoneId: string;
  version: string;
};

export function ResourcesScreen() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { total: number; available: boolean; stepFree: boolean }>>({});

  async function load() {
    try {
      const body = await api<{ resources: Resource[] }>('/api/views/resources');
      setResources(body.resources);
      setDrafts(Object.fromEntries(body.resources.map((resource) => [resource.resourceId, { total: resource.totalCapacity, available: resource.available, stepFree: resource.stepFree }])));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Resources unavailable.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="muted">Operator inventory, not a sensor reading</p>
          <h1>Water is stock. Charging is a slot.</h1>
        </div>
      </div>
      <p>Water completion moves a reserved unit into consumed stock. Charging completion releases the slot and does not consume it. A lower total is rejected when it would cut into reserved or consumed units. Marking a pool unavailable blocks new assignments and leaves active ones in place.</p>
      {error ? <div className="banner" role="alert">{error}</div> : null}
      {!resources.length && !error ? <p>Loading resources…</p> : null}
      <div className="list">
        {resources.map((resource) => {
          const draft = drafts[resource.resourceId];
          return (
            <form key={resource.resourceId} className="resource-card" onSubmit={(event) => {
              event.preventDefault();
              void api('/api/commands/resource', {
                method: 'POST',
                body: JSON.stringify({
                  resourceId: resource.resourceId,
                  expectedVersion: resource.version,
                  commandId: commandId(),
                  totalCapacity: draft.total,
                  available: draft.available,
                  stepFree: draft.stepFree,
                }),
              }).then(load).catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Update rejected.'));
            }}>
              <h2>{resource.label}</h2>
              <p>{resource.needType === 'WATER' ? 'Consumable stock' : 'Reusable staffed slot'} · zone {resource.zoneId} · version {resource.version}</p>
              <div className="metrics">
                <div className="metric"><b>{resource.totalCapacity}</b> total</div>
                <div className="metric"><b>{resource.reservedUnits}</b> reserved</div>
                <div className="metric"><b>{resource.consumedUnits}</b> consumed</div>
                <div className="metric"><b>{resource.freeUnits}</b> free now</div>
              </div>
              <div className="actions">
                <label htmlFor={`total-${resource.resourceId}`}>Total
                  <input id={`total-${resource.resourceId}`} name="totalCapacity" type="number" min={0} max={100} value={draft?.total ?? 0} onChange={(event) => setDrafts({ ...drafts, [resource.resourceId]: { ...draft, total: Number(event.target.value) } })} />
                </label>
                <label htmlFor={`available-${resource.resourceId}`}><input id={`available-${resource.resourceId}`} name="available" type="checkbox" checked={draft?.available ?? false} onChange={(event) => setDrafts({ ...drafts, [resource.resourceId]: { ...draft, available: event.target.checked } })} /> Available for new assignments</label>
                <label htmlFor={`stepfree-${resource.resourceId}`}><input id={`stepfree-${resource.resourceId}`} name="stepFree" type="checkbox" checked={draft?.stepFree ?? false} onChange={(event) => setDrafts({ ...drafts, [resource.resourceId]: { ...draft, stepFree: event.target.checked } })} /> Confirmed step-free</label>
                <button className="primary" type="submit">Save inventory</button>
              </div>
            </form>
          );
        })}
      </div>
    </main>
  );
}
