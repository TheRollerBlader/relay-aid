import { useEffect, useState } from 'react';
import { api, ApiError, commandId } from '../api';
import { clock, shortRef } from '../format';

type Plan = {
  planId: string;
  state: string;
  version: string;
  mode: string;
  modelId: string | null;
  explanation: string;
  solverVersion: string;
  allocations: Array<{ requestId: string; resourceId: string; travelSeconds: number; waitingRank: number }>;
  unmatched: Array<{ requestId: string; reason: string; detail: string }>;
  objective: { matchCount: number; waitingRankSum: number; travelSecondsSum: number };
  baselineMatchCount: number;
  baselineWaitingRankSum: number;
  baselineTravelSeconds: number;
  snapshotCreatedAt: string | null;
  snapshotExpiresAt: string | null;
  omittedCount: number;
  currentEpoch: string;
  snapshotEpoch: string | null;
  stale: boolean;
  expired: boolean;
  epochMismatch: boolean;
};

export function ProposalsScreen() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [serverTime, setServerTime] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('Needs another look');

  async function load() {
    const body = await api<{ plans: Plan[]; serverTime: string }>('/api/views/plans');
    setPlans(body.plans);
    setServerTime(body.serverTime);
  }

  useEffect(() => {
    void load().catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Plans unavailable.'));
  }, []);

  async function generate(path: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await api<{ ok: boolean; errorCode?: string; message?: string; liveModel?: boolean; modelId?: string; trace?: Array<{ tool: string }> }>(path, {
        method: 'POST',
        body: JSON.stringify({ commandId: commandId() }),
      });
      if (!body.ok) setError(body.message ?? body.errorCode ?? 'The proposal did not finish.');
      else setNotice(body.liveModel ? `Live model ${body.modelId} stored a proposal for review.` : 'Deterministic tool rehearsal stored a proposal. No live model ran.');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Proposal failed.');
    } finally {
      setBusy(false);
    }
  }

  const plan = plans[0];
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="muted">Human approval reserves capacity. A proposal does not.</p>
          <h1>Review the plan before anyone is assigned.</h1>
        </div>
      </div>
      <div className="actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void generate('/api/commands/deterministic-plan')}>{busy ? 'Working…' : 'Generate deterministic plan'}</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => void generate('/api/commands/nemotron-plan')}>Try Nemotron tools</button>
      </div>
      <p className="footer-note">The policy serves as many requests as it can, then prefers earlier server receipt, then shorter declared travel. It is not a promise that every older request wins when serving more people requires a different match.</p>
      {error ? <div className="banner" role="alert">{error}</div> : null}
      {notice ? <div className="banner ok">{notice}</div> : null}
      {!plan ? <div className="banner info">No proposal yet. Generate a deterministic plan, or make a one-item plan from the queue. Both use the same approval check.</div> : (
        <article className="plan-card">
          <p className="muted">{plan.mode === 'NEMOTRON' ? `Model ${plan.modelId}` : plan.mode === 'MANUAL' ? 'Manual one-item plan' : 'Deterministic tool rehearsal — no live model'} · {plan.solverVersion}</p>
          <h2>{plan.state} · snapshot {plan.snapshotEpoch} / current epoch {plan.currentEpoch}</h2>
          <p>Captured {clock(plan.snapshotCreatedAt)}. Expires {clock(plan.snapshotExpiresAt)}. Server time {clock(serverTime)}. Omitted from this batch: {plan.omittedCount}.</p>
          {plan.stale ? <div className="banner warn">{plan.expired ? 'This snapshot is older than ten minutes.' : 'The shelter changed after this snapshot.'} Approval is off until a person reviews a new proposal.</div> : null}
          <div className="metrics">
            <div className="metric"><b>{plan.objective.matchCount}</b> optimized matches</div>
            <div className="metric"><b>{plan.baselineMatchCount}</b> FCFS matches</div>
            <div className="metric"><b>{plan.objective.waitingRankSum}</b> waiting-rank sum</div>
          </div>
          <p>{plan.explanation}</p>
          <h3>Assignments</h3>
          {plan.allocations.length === 0 ? <p>No assignment in this plan.</p> : (
            <ul>{plan.allocations.map((item) => <li key={item.requestId}>{shortRef(item.requestId, item.resourceId.includes('water') ? 'WATER' : 'CHARGING')} → {item.resourceId} · declared travel {item.travelSeconds}s · waiting rank {item.waitingRank}</li>)}</ul>
          )}
          <h3>Unmatched</h3>
          {plan.unmatched.length === 0 ? <p>No eligible request was left unmatched.</p> : (
            <ul>{plan.unmatched.map((item) => <li key={item.requestId}><strong>{item.reason}</strong> · {item.detail}</li>)}</ul>
          )}
          {plan.state === 'PROPOSED' ? (
            <div className="actions">
              <button type="button" className="primary" disabled={busy || plan.stale} onClick={() => void api('/api/commands/approve', { method: 'POST', body: JSON.stringify({ planId: plan.planId, expectedPlanVersion: plan.version, commandId: commandId() }) }).then(async () => { setNotice('Approved. Capacity is reserved.'); await load(); }).catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Approval rejected.'))}>Approve this exact plan</button>
              <label htmlFor="reject-reason">Reject reason
                <input id="reject-reason" name="reason" value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              <button type="button" className="secondary" disabled={busy} onClick={() => void api('/api/commands/reject', { method: 'POST', body: JSON.stringify({ planId: plan.planId, expectedPlanVersion: plan.version, commandId: commandId(), reason }) }).then(load)}>Reject without reserving</button>
            </div>
          ) : <p>This plan is {plan.state}. Rejecting or approving it again will not reserve capacity twice.</p>}
        </article>
      )}
    </main>
  );
}
