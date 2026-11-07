import { useEffect, useState } from 'react';
import { api, ApiError, commandId } from '../api';

type Assignment = {
  assignmentId: string;
  assignmentVersion: string;
  state: string;
  requestId: string;
  requestVersion: string | null;
  requestState: string | null;
  needType: string | null;
  zoneId: string | null;
  resourceLabel: string;
};

export function VolunteerScreen() {
  const [label, setLabel] = useState('Volunteer');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    const body = await api<{ displayLabel: string; assignments: Assignment[] }>('/api/views/volunteer');
    setLabel(body.displayLabel);
    setAssignments(body.assignments);
  }

  useEffect(() => {
    void load().catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Assignments unavailable.'));
  }, []);

  const active = assignments.filter((assignment) => assignment.state === 'ACTIVE');
  return (
    <main className="home">
      <p className="muted">{label}</p>
      <h1>Only the task attached to you.</h1>
      <p>There is no resident directory on this screen. Completing a task records you as the actor and settles the resource once.</p>
      {error ? <div className="banner" role="alert">{error}</div> : null}
      {notice ? <div className="banner ok">{notice}</div> : null}
      {active.length === 0 ? <div className="banner info">No active task is attached. A coordinator attaches one after approving an assignment. An empty list here does not mean the queue is empty.</div> : null}
      <div className="list">
        {active.map((assignment) => (
          <article key={assignment.assignmentId} className="detail">
            <h2>{assignment.needType === 'WATER' ? 'Water' : 'Charging'} · {assignment.zoneId}</h2>
            <p>{assignment.resourceLabel}</p>
            <button
              type="button"
              className="primary"
              onClick={() => void api('/api/commands/complete', {
                method: 'POST',
                body: JSON.stringify({
                  assignmentId: assignment.assignmentId,
                  expectedAssignmentVersion: assignment.assignmentVersion,
                  expectedRequestVersion: assignment.requestVersion,
                  commandId: commandId(),
                }),
              }).then(async () => {
                setNotice('Marked complete.');
                await load();
              }).catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Completion was rejected.'))}
            >
              Mark complete
            </button>
          </article>
        ))}
      </div>
    </main>
  );
}
