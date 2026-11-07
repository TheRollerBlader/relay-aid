import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_IDS, type SubmitRequestV1 } from '@relayaid/contracts';
import { Authority } from '@relayaid/authority';
import { McuLogic, SerialBridge, StationStore, backoffMs } from './index';

function file(): string {
  return join(mkdtempSync(join(tmpdir(), 'relayaid-')), 'station.sqlite');
}

describe('station durability', () => {
  it('commits before a saved result and refuses when the write is blocked', () => {
    const store = StationStore.open(file());
    store.injectFailureBeforeCommit();
    const blocked = store.confirmSoftwarePress('WATER', 'pointer', '2026-11-07T23:00:00.000Z');
    expect(blocked).toMatchObject({ ok: false, type: 'NOT_SAVED' });
    expect(store.listOutbox()).toHaveLength(0);
    const saved = store.confirmSoftwarePress('CHARGING', 'keyboard', '2026-11-07T23:00:01.000Z');
    expect(saved.ok).toBe(true);
    expect(store.display().code).toBe('SAVED_LOCAL');
    expect(store.display().copy.title).toContain('Not delivered');
    store.close();
  });

  it('reopens the same request ids after a restart and replays one serial press', () => {
    const path = file();
    const first = StationStore.open(path);
    const saved = first.confirmSoftwarePress('WATER', 'pointer', '2026-11-07T23:00:00.000Z');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    first.close();
    const second = StationStore.open(path);
    expect(second.listOutbox().map((row) => row.request_id)).toEqual([saved.requestId]);
    expect(second.pendingCount()).toBe(1);
    const lines: string[] = [];
    const bridge = new SerialBridge(second, (frame) => lines.push(frame.trim()));
    const mcu = new McuLogic();
    bridge.onLine(JSON.stringify(mcu.helloFrame()));
    const session = JSON.parse(lines.at(-1)!) as { sessionId: string };
    mcu.onFrame({ type: 'SESSION', sessionId: session.sessionId });
    let now = 1_000;
    mcu.sample(false, true, now);
    now += 50;
    const press = mcu.sample(false, true, now);
    expect(press).not.toBeNull();
    bridge.onLine(JSON.stringify(press));
    const savedFrame = JSON.parse(lines.at(-1)!) as { type: string; requestId: string; pressSeq: number };
    expect(savedFrame.type).toBe('SAVED');
    bridge.onLine(JSON.stringify(mcu.repeat()));
    const replay = JSON.parse(lines.at(-1)!) as { requestId: string };
    expect(replay.requestId).toBe(savedFrame.requestId);
    expect(second.listOutbox().filter((row) => row.request_id === savedFrame.requestId)).toHaveLength(1);
    second.close();
  });

  it('debounces bounce and accepts two deliberate confirms as different requests', () => {
    const store = StationStore.open(file());
    const lines: string[] = [];
    const bridge = new SerialBridge(store, (frame) => lines.push(frame.trim()));
    const mcu = new McuLogic();
    bridge.onLine(JSON.stringify(mcu.helloFrame()));
    mcu.onFrame(JSON.parse(lines.at(-1)!));
    let now = 0;
    mcu.sample(false, true, now);
    now += 10;
    expect(mcu.sample(false, false, now)).toBeNull();
    now += 5;
    mcu.sample(false, true, now);
    now += 10;
    expect(mcu.sample(false, false, now)).toBeNull();
    now = 200;
    mcu.sample(false, true, now);
    now = 260;
    const first = mcu.sample(false, true, now);
    bridge.onLine(JSON.stringify(first));
    mcu.onFrame(JSON.parse(lines.at(-1)!));
    now = 400;
    mcu.sample(true, false, now);
    now = 460;
    mcu.sample(true, false, now);
    expect(mcu.selected).toBe('CHARGING');
    now = 500;
    mcu.sample(false, true, now);
    now = 560;
    const second = mcu.sample(false, true, now);
    bridge.onLine(JSON.stringify(second));
    mcu.onFrame(JSON.parse(lines.at(-1)!));
    const ids = store.listOutbox().map((row) => row.request_id);
    expect(new Set(ids).size).toBe(2);
    expect(store.listOutbox().map((row) => JSON.parse(row.payload).needType)).toEqual(['WATER', 'CHARGING']);
    store.close();
  });

  it('retries a lost receipt without a second server request', async () => {
    const authority = Authority.demo();
    const store = StationStore.open(file());
    const saved = store.confirmSoftwarePress('WATER', 'pointer', '2026-11-07T23:06:00.000Z');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    let attempts = 0;
    const client = {
      async submit(payload: SubmitRequestV1) {
        const receipt = authority.submitRequest(DEMO_IDS.identities.station, payload);
        attempts += 1;
        if (attempts === 1) throw new Error('dropped receipt');
        return receipt;
      },
      async statuses() {
        return authority.myStationRequests(DEMO_IDS.identities.station).requests.map((request) => ({
          requestId: request.requestId,
          version: request.version,
          state: request.state,
        }));
      },
    };
    const start = Date.parse('2026-11-07T23:06:01.000Z');
    await store.syncOnce(client, { uplink: false, nowMs: start });
    expect(authority.myStationRequests(DEMO_IDS.identities.station).requests.some((request) => request.requestId === saved.requestId)).toBe(false);
    await store.syncOnce(client, { uplink: true, nowMs: start, jitter: 0 });
    expect(store.listOutbox()[0].transport_state).toBe('RETRYABLE_ERROR');
    await store.syncOnce(client, { uplink: true, nowMs: start + backoffMs(1, 0), jitter: 0 });
    const serverRows = authority.myStationRequests(DEMO_IDS.identities.station).requests.filter((request) => request.requestId === saved.requestId);
    expect(serverRows).toHaveLength(1);
    expect(store.listOutbox()[0].transport_state).toBe('DELIVERED');
    expect(store.display(saved.requestId).code).toBe('DELIVERED');
    store.close();
  });

  it('does not regress a newer completion behind a stale acknowledgement', () => {
    const store = StationStore.open(file());
    const saved = store.confirmSoftwarePress('WATER', 'keyboard', '2026-11-07T23:00:00.000Z');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    store.applyStatus(saved.requestId, '3', 'COMPLETED', '2026-11-07T23:10:00.000Z');
    const changed = store.applyStatus(saved.requestId, '2', 'ACKNOWLEDGED', '2026-11-07T23:11:00.000Z');
    expect(changed).toBe(false);
    expect(store.cacheFor(saved.requestId)?.state).toBe('COMPLETED');
    store.close();
  });

  it('keeps the accepted id set equal to the delivered set across drops', async () => {
    const authority = Authority.demo();
    const store = StationStore.open(file());
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const saved = store.confirmSoftwarePress(index % 2 === 0 ? 'WATER' : 'CHARGING', 'pointer', '2026-11-07T23:20:00.000Z');
      expect(saved.ok).toBe(true);
      if (saved.ok) ids.push(saved.requestId);
    }
    let drops = 0;
    const client = {
      async submit(payload: SubmitRequestV1) {
        const receipt = authority.submitRequest(DEMO_IDS.identities.station, payload);
        drops += 1;
        if (drops % 3 === 0) throw new Error('drop');
        return receipt;
      },
      async statuses() {
        return [];
      },
    };
    let now = Date.parse('2026-11-07T23:21:00.000Z');
    for (let turn = 0; turn < 80 && store.pendingCount() > 0; turn += 1) {
      await store.syncOnce(client, { uplink: true, nowMs: now, jitter: 0 });
      now += 31_000;
    }
    expect(store.pendingCount()).toBe(0);
    const delivered = new Set(store.listOutbox().filter((row) => row.transport_state === 'DELIVERED').map((row) => row.request_id));
    expect([...delivered].sort()).toEqual([...ids].sort());
    const serverIds = authority
      .myStationRequests(DEMO_IDS.identities.station)
      .requests.map((request) => request.requestId)
      .filter((requestId) => ids.includes(requestId));
    expect(serverIds.sort()).toEqual([...ids].sort());
    expect(new Set(authority.myStationRequests(DEMO_IDS.identities.station).requests.map((request) => request.requestId)).size).toBe(
      authority.myStationRequests(DEMO_IDS.identities.station).requests.length,
    );
    store.close();
  });
});
