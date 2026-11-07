import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './app';

let running: RunningServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function client(base: string) {
  let cookie = '';
  return async function call(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    headers.set('x-relayaid-request', '1');
    if (cookie) headers.set('cookie', cookie);
    if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(`${base}${path}`, { ...init, headers });
    const set = response.headers.getSetCookie?.() ?? [];
    if (set[0]) cookie = set[0].split(';')[0];
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

describe('http loop', () => {
  it('saves locally, delivers once, and completes only after a human approval', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'relayaid-http-'));
    running = await startServer({ port: 0, dataDir, webDist: join(dataDir, 'missing-dist') });
    const api = client(running.url);
    const health = await api('/api/health');
    expect(health.body.backend).toBe('local-authority');
    expect(health.body.nemotron).toBe('unavailable');
    expect(health.body.spacetime).toBe('not-connected');

    expect((await api('/api/views/queue')).status).toBe(401);
    await api('/api/session', { method: 'POST', body: JSON.stringify({ role: 'station' }) });
    const blocked = await api('/api/commands/approve', { method: 'POST', body: JSON.stringify({ planId: 'x', expectedPlanVersion: '1', commandId: crypto.randomUUID() }) });
    expect(blocked.status).toBe(403);

    await api('/api/station/uplink', { method: 'POST', body: JSON.stringify({ connected: false }) });
    await api('/api/station/selection', { method: 'POST', body: JSON.stringify({ need: 'WATER' }) });
    const saved = await api('/api/station/confirm', { method: 'POST', body: JSON.stringify({ source: 'pointer' }) });
    expect(saved.body.saved).toBe(true);
    expect(saved.body.station.focus.code).toBe('SAVED_LOCAL');
    expect(saved.body.station.focus.copy.title).toContain('Not delivered');
    const requestId = saved.body.requestId as string;

    await api('/api/session', { method: 'POST', body: JSON.stringify({ role: 'coordinator' }) });
    const before = await api('/api/views/queue');
    expect(before.body.requests.some((request: { requestId: string }) => request.requestId === requestId)).toBe(false);

    await api('/api/session', { method: 'POST', body: JSON.stringify({ role: 'station' }) });
    await api('/api/station/uplink', { method: 'POST', body: JSON.stringify({ connected: true }) });
    let delivered = false;
    for (let attempt = 0; attempt < 20 && !delivered; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const view = await api('/api/station');
      delivered = view.body.focus?.requestId === requestId && view.body.focus?.code === 'DELIVERED';
    }
    expect(delivered).toBe(true);

    await api('/api/session', { method: 'POST', body: JSON.stringify({ role: 'coordinator' }) });
    const queue = await api('/api/views/queue');
    const row = queue.body.requests.find((request: { requestId: string }) => request.requestId === requestId);
    expect(row.state).toBe('NEW');
    const ack = await api('/api/commands/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ requestId, expectedVersion: row.version, commandId: crypto.randomUUID() }),
    });
    expect(ack.body.outcome).toBe('ACCEPTED');
    const manual = await api('/api/commands/manual-plan', {
      method: 'POST',
      body: JSON.stringify({
        requestId,
        resourceId: 'water-a',
        expectedRequestVersion: ack.body.requestVersion,
        commandId: crypto.randomUUID(),
      }),
    });
    expect(manual.body.outcome).toBe('ACCEPTED');
    const approved = await api('/api/commands/approve', {
      method: 'POST',
      body: JSON.stringify({ planId: manual.body.requestId, expectedPlanVersion: '1', commandId: crypto.randomUUID() }),
    });
    expect(approved.body.outcome).toBe('ACCEPTED');
    const replay = await api('/api/commands/approve', {
      method: 'POST',
      body: JSON.stringify({ planId: manual.body.requestId, expectedPlanVersion: '1', commandId: approved.body.commandId }),
    });
    expect(replay.body.outcome).toBe('ACCEPTED');
    const after = await api('/api/views/queue');
    const assigned = after.body.requests.find((request: { requestId: string }) => request.requestId === requestId);
    const done = await api('/api/commands/complete', {
      method: 'POST',
      body: JSON.stringify({
        assignmentId: assigned.assignmentId,
        expectedAssignmentVersion: assigned.assignmentVersion,
        expectedRequestVersion: assigned.version,
        commandId: crypto.randomUUID(),
      }),
    });
    expect(done.body.outcome).toBe('ACCEPTED');
    const resources = await api('/api/views/resources');
    const water = resources.body.resources.find((resource: { resourceId: string }) => resource.resourceId === 'water-a');
    expect(water).toMatchObject({ reservedUnits: 0, consumedUnits: 1 });

    const nemotron = await api('/api/commands/nemotron-plan', { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID() }) });
    expect(nemotron.body.ok).toBe(false);
    expect(nemotron.body.errorCode).toBe('MODEL_UNAVAILABLE');
    const deterministic = await api('/api/commands/deterministic-plan', { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID() }) });
    expect(deterministic.body.ok).toBe(true);
    expect(deterministic.body.liveModel).toBe(false);
    expect(deterministic.body.trace.map((entry: { tool: string }) => entry.tool)).toContain('solveAssignment');
    expect(deterministic.body.trace.map((entry: { tool: string }) => entry.tool)).not.toContain('approvePlan');

    await api('/api/session', { method: 'POST', body: JSON.stringify({ role: 'station' }) });
    let completed = false;
    for (let attempt = 0; attempt < 20 && !completed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const view = await api('/api/station');
      const card = view.body.requests.find((request: { requestId: string }) => request.requestId === requestId);
      completed = card?.code === 'COMPLETED';
    }
    expect(completed).toBe(true);
  });
});
