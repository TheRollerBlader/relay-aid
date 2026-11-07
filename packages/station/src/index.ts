import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  cmpDecimal,
  encodeFrame,
  parseSerialFrame,
  validatePressFrame,
  validateSubmitRequest,
  type NeedType,
  type ReceiptV1,
  type RequestState,
  type SubmitRequestV1,
  type TransportState,
} from '@relayaid/contracts';

export type ResidentCode = 'READY' | 'SAVED_LOCAL' | 'DELIVERED' | 'ACKNOWLEDGED' | 'ASSIGNED' | 'COMPLETED' | 'CANCELLED' | 'ERROR';

export type InputSource = 'serial' | 'pointer' | 'keyboard';

export type AcceptResult =
  | { ok: true; type: 'SAVED'; requestId: string; pressSeq: number; duplicate: boolean; payload: SubmitRequestV1 }
  | { ok: false; type: 'NOT_SAVED'; error: 'LOCAL_STORAGE_FAILED' };

type OutboxRow = {
  request_id: string;
  local_sequence: string;
  command_id: string;
  payload: string;
  transport_state: TransportState;
  attempt_count: number;
  retry_at: string | null;
  last_error: string | null;
  source: string;
  created_at: string;
  session_id: string;
  press_seq: number;
};

export type SyncClient = {
  submit: (payload: SubmitRequestV1) => Promise<ReceiptV1>;
  statuses: () => Promise<Array<{ requestId: string; version: string; state: RequestState }>>;
};

const RESIDENT_COPY: Record<ResidentCode, { title: string; detail: string; pattern: string; tone: string }> = {
  READY: {
    title: 'Select a need, then confirm',
    detail: 'Nothing is submitted until you confirm.',
    pattern: 'off',
    tone: 'neutral',
  },
  SAVED_LOCAL: {
    title: 'Saved on this station. Not delivered yet.',
    detail: 'The request is on this laptop. A coordinator has not received it.',
    pattern: 'pulse',
    tone: 'amber',
  },
  DELIVERED: {
    title: 'Delivered. Waiting for coordinator acknowledgement.',
    detail: 'The server has the request. Acknowledgement is a separate human step.',
    pattern: 'steady',
    tone: 'amber',
  },
  ACKNOWLEDGED: {
    title: 'Coordinator acknowledged your request.',
    detail: 'A person confirmed the request. An assignment is still pending.',
    pattern: 'steady',
    tone: 'blue',
  },
  ASSIGNED: {
    title: 'Assignment approved. Completion is still pending.',
    detail: 'Capacity was reserved. This is coordination, not a guarantee that help has arrived.',
    pattern: 'double',
    tone: 'blue',
  },
  COMPLETED: {
    title: 'Marked complete by staff.',
    detail: 'A coordinator or assigned volunteer closed this request.',
    pattern: 'steady',
    tone: 'green',
  },
  CANCELLED: {
    title: 'Cancelled by staff.',
    detail: 'This request will not be assigned. Ask staff if you still need help.',
    pattern: 'steady',
    tone: 'neutral',
  },
  ERROR: {
    title: 'Needs staff review.',
    detail: 'This request was not accepted or could not be synced. The earlier record was kept.',
    pattern: 'stripe',
    tone: 'alert',
  },
};

export function residentCopy(code: ResidentCode) {
  return RESIDENT_COPY[code];
}

export function backoffMs(attempt: number, jitterUnit = 0): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(base * 0.25 * Math.min(1, Math.max(0, jitterUnit)));
}

export class StationStore {
  private failBeforeCommit = false;
  readonly installationId: string;

  constructor(private readonly db: DatabaseSync) {
    this.installationId = this.ensureInstallation();
    this.db.prepare('UPDATE outbox SET transport_state = ? WHERE transport_state = ? AND attempt_count >= 0 AND last_error = ?').run(
      'PENDING',
      'PENDING',
      '__in_flight__',
    );
    this.db.prepare(`UPDATE outbox SET last_error = NULL WHERE last_error = '__in_flight__'`).run();
  }

  static open(file: string): StationStore {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS installation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        installation_id TEXT NOT NULL,
        next_sequence INTEGER NOT NULL,
        software_session_id TEXT,
        software_press_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcu_session (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS press_inbox (
        session_id TEXT NOT NULL,
        press_seq INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        need_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, press_seq)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        request_id TEXT PRIMARY KEY,
        local_sequence TEXT NOT NULL UNIQUE,
        command_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        transport_state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        retry_at TEXT,
        last_error TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        press_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_cache (
        request_id TEXT PRIMARY KEY,
        server_version TEXT,
        server_state TEXT,
        observed_at TEXT NOT NULL
      );
    `);
    return new StationStore(db);
  }

  close(): void {
    this.db.close();
  }

  injectFailureBeforeCommit(): void {
    this.failBeforeCommit = true;
  }

  private ensureInstallation(): string {
    const existing = this.db.prepare('SELECT installation_id FROM installation WHERE id = 1').get() as { installation_id: string } | undefined;
    if (existing) return existing.installation_id;
    const installationId = randomUUID();
    this.db
      .prepare('INSERT INTO installation (id, installation_id, next_sequence, software_press_seq, created_at) VALUES (1, ?, 1, 0, ?)')
      .run(installationId, new Date().toISOString());
    return installationId;
  }

  ensureMcuSession(sessionId: string | null, booted: boolean): string | null {
    if (sessionId) {
      const known = this.db.prepare('SELECT session_id FROM mcu_session WHERE session_id = ?').get(sessionId) as { session_id: string } | undefined;
      if (known) {
        this.db.prepare('UPDATE mcu_session SET last_seen_at = ? WHERE session_id = ?').run(new Date().toISOString(), sessionId);
        return known.session_id;
      }
      if (!booted) return null;
    }
    const created = randomUUID();
    this.db.prepare('INSERT INTO mcu_session (session_id, created_at, last_seen_at) VALUES (?, ?, ?)').run(created, new Date().toISOString(), new Date().toISOString());
    return created;
  }

  rememberSession(sessionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO mcu_session (session_id, created_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ).run(sessionId, now, now);
  }

  acceptPress(input: {
    sessionId: string;
    pressSeq: number;
    need: NeedType;
    source: InputSource;
    deviceCreatedAt: string;
    requestId?: string;
    commandId?: string;
  }): AcceptResult {
    if (this.failBeforeCommit) {
      this.failBeforeCommit = false;
      return { ok: false, type: 'NOT_SAVED', error: 'LOCAL_STORAGE_FAILED' };
    }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existing = this.db
        .prepare(
          `SELECT press_inbox.request_id AS request_id, outbox.payload AS payload
           FROM press_inbox JOIN outbox ON outbox.request_id = press_inbox.request_id
           WHERE press_inbox.session_id = ? AND press_inbox.press_seq = ?`,
        )
        .get(input.sessionId, input.pressSeq) as { request_id: string; payload: string } | undefined;
      if (existing) {
        this.db.exec('COMMIT');
        return {
          ok: true,
          type: 'SAVED',
          requestId: existing.request_id,
          pressSeq: input.pressSeq,
          duplicate: true,
          payload: JSON.parse(existing.payload) as SubmitRequestV1,
        };
      }
      const sequenceRow = this.db.prepare('SELECT next_sequence FROM installation WHERE id = 1').get() as { next_sequence: number };
      const localSequence = String(sequenceRow.next_sequence);
      this.db.prepare('UPDATE installation SET next_sequence = next_sequence + 1 WHERE id = 1').run();
      const requestId = input.requestId ?? randomUUID();
      const commandId = input.commandId ?? randomUUID();
      const payload: SubmitRequestV1 = {
        schemaVersion: 1,
        commandId,
        requestId,
        localSequence,
        needType: input.need,
        units: 1,
        deviceCreatedAt: input.deviceCreatedAt,
      };
      validateSubmitRequest(payload);
      const createdAt = new Date().toISOString();
      this.db.prepare('INSERT INTO press_inbox (session_id, press_seq, request_id, need_type, created_at) VALUES (?, ?, ?, ?, ?)').run(
        input.sessionId,
        input.pressSeq,
        requestId,
        input.need,
        createdAt,
      );
      this.db
        .prepare(
          `INSERT INTO outbox (
            request_id, local_sequence, command_id, payload, transport_state, attempt_count, retry_at, last_error, source, created_at, session_id, press_seq
          ) VALUES (?, ?, ?, ?, 'PENDING', 0, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(requestId, localSequence, commandId, JSON.stringify(payload), input.source, createdAt, input.sessionId, input.pressSeq);
      this.db.exec('COMMIT');
      return { ok: true, type: 'SAVED', requestId, pressSeq: input.pressSeq, duplicate: false, payload };
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* already closed */
      }
      return { ok: false, type: 'NOT_SAVED', error: 'LOCAL_STORAGE_FAILED' };
    }
  }

  confirmSoftwarePress(need: NeedType, source: InputSource, deviceCreatedAt: string): AcceptResult {
    const row = this.db.prepare('SELECT software_session_id, software_press_seq FROM installation WHERE id = 1').get() as {
      software_session_id: string | null;
      software_press_seq: number;
    };
    let sessionId = row.software_session_id;
    if (!sessionId) {
      sessionId = randomUUID();
      this.db.prepare('UPDATE installation SET software_session_id = ? WHERE id = 1').run(sessionId);
      this.rememberSession(sessionId);
    }
    const pressSeq = row.software_press_seq + 1;
    const result = this.acceptPress({ sessionId, pressSeq, need, source, deviceCreatedAt });
    if (result.ok) {
      this.db.prepare('UPDATE installation SET software_press_seq = ? WHERE id = 1 AND software_press_seq < ?').run(pressSeq, pressSeq);
    }
    return result;
  }

  listOutbox(): OutboxRow[] {
    return this.db.prepare('SELECT * FROM outbox ORDER BY local_sequence').all() as unknown as OutboxRow[];
  }

  pendingCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM outbox WHERE transport_state IN ('PENDING', 'RETRYABLE_ERROR')`)
      .get() as { count: number };
    return row.count;
  }

  applyStatus(requestId: string, version: string, state: RequestState, observedAt: string): boolean {
    const current = this.db.prepare('SELECT server_version FROM request_cache WHERE request_id = ?').get(requestId) as
      | { server_version: string | null }
      | undefined;
    if (current?.server_version && cmpDecimal(version, current.server_version) <= 0) return false;
    this.db
      .prepare(
        `INSERT INTO request_cache (request_id, server_version, server_state, observed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET server_version = excluded.server_version, server_state = excluded.server_state, observed_at = excluded.observed_at`,
      )
      .run(requestId, version, state, observedAt);
    return true;
  }

  cacheFor(requestId: string): { version: string; state: RequestState } | null {
    const row = this.db.prepare('SELECT server_version, server_state FROM request_cache WHERE request_id = ?').get(requestId) as
      | { server_version: string; server_state: RequestState }
      | undefined;
    if (!row?.server_version) return null;
    return { version: row.server_version, state: row.server_state };
  }

  display(selectedRequestId?: string | null): {
    code: ResidentCode;
    requestId: string | null;
    copy: ReturnType<typeof residentCopy>;
    pendingCount: number;
    source: string | null;
  } {
    const rows = this.listOutbox();
    const pendingCount = rows.filter((row) => row.transport_state === 'PENDING' || row.transport_state === 'RETRYABLE_ERROR').length;
    const selected = rows.find((row) => row.request_id === selectedRequestId) ?? rows[rows.length - 1];
    if (!selected) {
      return { code: 'READY', requestId: null, copy: residentCopy('READY'), pendingCount, source: null };
    }
    if (selected.transport_state === 'CONFLICT') {
      return { code: 'ERROR', requestId: selected.request_id, copy: residentCopy('ERROR'), pendingCount, source: selected.source };
    }
    const cached = this.cacheFor(selected.request_id);
    if (!cached || selected.transport_state !== 'DELIVERED') {
      return { code: 'SAVED_LOCAL', requestId: selected.request_id, copy: residentCopy('SAVED_LOCAL'), pendingCount, source: selected.source };
    }
    const code = (['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'COMPLETED', 'CANCELLED'].includes(cached.state)
      ? cached.state === 'NEW'
        ? 'DELIVERED'
        : (cached.state as ResidentCode)
      : 'ERROR') as ResidentCode;
    return { code, requestId: selected.request_id, copy: residentCopy(code), pendingCount, source: selected.source };
  }

  async syncOnce(client: SyncClient, options: { uplink: boolean; nowMs: number; jitter?: number }): Promise<{ delivered: string[]; conflicts: string[] }> {
    const delivered: string[] = [];
    const conflicts: string[] = [];
    if (!options.uplink) return { delivered, conflicts };
    const due = this.listOutbox().find((row) => {
      if (row.transport_state !== 'PENDING' && row.transport_state !== 'RETRYABLE_ERROR') return false;
      if (!row.retry_at) return true;
      return Date.parse(row.retry_at) <= options.nowMs;
    });
    if (!due) {
      await this.pullStatuses(client);
      return { delivered, conflicts };
    }
    const payload = JSON.parse(due.payload) as SubmitRequestV1;
    this.db.prepare(`UPDATE outbox SET last_error = '__in_flight__' WHERE request_id = ?`).run(due.request_id);
    try {
      const receipt = await client.submit(payload);
      if (receipt.outcome === 'ACCEPTED' && receipt.requestId === payload.requestId) {
        this.db
          .prepare(`UPDATE outbox SET transport_state = 'DELIVERED', last_error = NULL, retry_at = NULL WHERE request_id = ?`)
          .run(due.request_id);
        if (receipt.requestVersion) this.applyStatus(payload.requestId, receipt.requestVersion, 'NEW', new Date(options.nowMs).toISOString());
        delivered.push(payload.requestId);
      } else if (receipt.errorCode === 'IDEMPOTENCY_CONFLICT' || receipt.errorCode === 'INVALID_SCHEMA' || receipt.errorCode === 'UNSUPPORTED_CATEGORY') {
        this.db
          .prepare(`UPDATE outbox SET transport_state = 'CONFLICT', last_error = ? WHERE request_id = ?`)
          .run(receipt.errorCode, due.request_id);
        conflicts.push(payload.requestId);
      } else {
        this.scheduleRetry(due, receipt.errorCode ?? 'UNKNOWN_RESULT', options);
      }
    } catch {
      this.scheduleRetry(due, 'NETWORK_UNAVAILABLE', options);
    }
    await this.pullStatuses(client);
    return { delivered, conflicts };
  }

  private scheduleRetry(row: OutboxRow, code: string, options: { nowMs: number; jitter?: number }): void {
    const attempt = row.attempt_count + 1;
    const retryAt = new Date(options.nowMs + backoffMs(attempt, options.jitter ?? 0)).toISOString();
    this.db
      .prepare(`UPDATE outbox SET transport_state = 'RETRYABLE_ERROR', attempt_count = ?, retry_at = ?, last_error = ? WHERE request_id = ?`)
      .run(attempt, retryAt, code, row.request_id);
  }

  private async pullStatuses(client: SyncClient): Promise<void> {
    try {
      const statuses = await client.statuses();
      const observed = new Date().toISOString();
      for (const status of statuses) this.applyStatus(status.requestId, status.version, status.state, observed);
    } catch {
      /* status pull is retryable and must not create a request */
    }
  }

  backupTo(file: string): void {
    const copy = StationStore.open(file);
    const installation = this.db.prepare('SELECT * FROM installation WHERE id = 1').get();
    copy.db.prepare('DELETE FROM installation').run();
    copy.db.prepare('INSERT INTO installation (id, installation_id, next_sequence, software_session_id, software_press_seq, created_at) VALUES (1, ?, ?, ?, ?, ?)').run(
      (installation as { installation_id: string }).installation_id,
      (installation as { next_sequence: number }).next_sequence,
      (installation as { software_session_id: string | null }).software_session_id,
      (installation as { software_press_seq: number }).software_press_seq,
      (installation as { created_at: string }).created_at,
    );
    for (const table of ['mcu_session', 'press_inbox', 'outbox', 'request_cache'] as const) {
      const rows = this.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const keys = Object.keys(row);
        copy.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(
          ...keys.map((key) => {
            const value = row[key];
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value === null) return value;
            return value == null ? null : String(value);
          }),
        );
      }
    }
    copy.close();
  }
}

export class SerialBridge {
  constructor(
    private readonly store: StationStore,
    private readonly write: (frame: string) => void,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: Record<string, unknown>;
    try {
      frame = parseSerialFrame(trimmed);
    } catch {
      this.write(encodeFrame({ v: 1, type: 'NOT_SAVED', error: 'INVALID_SCHEMA' }));
      return;
    }
    if (frame.type === 'HELLO') {
      const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : null;
      const booted = frame.booted === true;
      const resolved = this.store.ensureMcuSession(sessionId, booted || !sessionId);
      if (!resolved) {
        this.write(encodeFrame({ v: 1, type: 'NOT_SAVED', error: 'UNKNOWN_SESSION' }));
        return;
      }
      this.write(encodeFrame({ v: 1, type: 'SESSION', sessionId: resolved }));
      return;
    }
    if (frame.type !== 'PRESS') {
      this.write(encodeFrame({ v: 1, type: 'NOT_SAVED', error: 'INVALID_SCHEMA' }));
      return;
    }
    let press;
    try {
      press = validatePressFrame(frame);
    } catch {
      this.write(encodeFrame({ v: 1, type: 'NOT_SAVED', error: 'INVALID_SCHEMA' }));
      return;
    }
    const known = this.store.ensureMcuSession(press.sessionId, false);
    if (known !== press.sessionId) {
      this.write(encodeFrame({ v: 1, type: 'NOT_SAVED', error: 'UNKNOWN_SESSION' }));
      return;
    }
    const saved = this.store.acceptPress({
      sessionId: press.sessionId,
      pressSeq: press.pressSeq,
      need: press.need,
      source: 'serial',
      deviceCreatedAt: this.nowIso(),
    });
    if (!saved.ok) {
      this.write(encodeFrame({ v: 1, type: 'NOT_SAVED', error: 'LOCAL_STORAGE_FAILED' }));
      return;
    }
    this.write(encodeFrame({ v: 1, type: 'SAVED', pressSeq: press.pressSeq, requestId: saved.requestId }));
  }

  pushStatus(requestId: string, version: string, state: string): void {
    this.write(encodeFrame({ v: 1, type: 'STATUS', requestId, version, state }));
  }
}

const DEBOUNCE_MS = 50;

/** Host-side model of the station firmware state machine. The Pico script follows the same rules. */
export class McuLogic {
  sessionId: string | null = null;
  private pressSeq = 0;
  pending: { pressSeq: number; need: NeedType } | null = null;
  selected: NeedType = 'WATER';
  private cycleHeld = false;
  private confirmHeld = false;
  private cycleStableSince: number | null = null;
  private confirmStableSince: number | null = null;
  private cycleLatched = false;
  private confirmLatched = false;

  helloFrame(): { v: 1; type: 'HELLO'; sessionId: string | null; booted: boolean; pendingPressSeq: number | null } {
    return { v: 1, type: 'HELLO', sessionId: this.sessionId, booted: this.sessionId === null, pendingPressSeq: this.pending?.pressSeq ?? null };
  }

  /** Sample buttons. Returns a PRESS frame only for a new debounced confirmation. */
  sample(cycleDown: boolean, confirmDown: boolean, nowMs: number): { v: 1; type: 'PRESS'; sessionId: string; pressSeq: number; need: NeedType } | null {
    this.track(cycleDown, this.cycleHeld, nowMs, 'cycle');
    this.track(confirmDown, this.confirmHeld, nowMs, 'confirm');
    this.cycleHeld = cycleDown;
    this.confirmHeld = confirmDown;
    if (!cycleDown) this.cycleLatched = false;
    if (!confirmDown) this.confirmLatched = false;
    if (cycleDown && this.cycleStableSince !== null && nowMs - this.cycleStableSince >= DEBOUNCE_MS && !this.cycleLatched) {
      this.cycleLatched = true;
      this.selected = this.selected === 'WATER' ? 'CHARGING' : 'WATER';
    }
    if (this.pending || !this.sessionId) return this.pending && this.sessionId ? this.pressFrame() : null;
    if (confirmDown && this.confirmStableSince !== null && nowMs - this.confirmStableSince >= DEBOUNCE_MS && !this.confirmLatched) {
      this.confirmLatched = true;
      this.pressSeq += 1;
      this.pending = { pressSeq: this.pressSeq, need: this.selected };
      return this.pressFrame();
    }
    return null;
  }

  repeat(): { v: 1; type: 'PRESS'; sessionId: string; pressSeq: number; need: NeedType } | null {
    if (!this.pending || !this.sessionId) return null;
    return this.pressFrame();
  }

  onFrame(frame: { type?: string; pressSeq?: number; sessionId?: string }): void {
    if (frame.type === 'SESSION' && typeof frame.sessionId === 'string') {
      if (this.sessionId && frame.sessionId !== this.sessionId) {
        this.pending = null;
        this.pressSeq = 0;
      }
      this.sessionId = frame.sessionId;
    }
    if (frame.type === 'SAVED' && frame.pressSeq === this.pending?.pressSeq) this.pending = null;
  }

  reboot(): void {
    this.sessionId = null;
    this.pending = null;
    this.pressSeq = 0;
    this.selected = 'WATER';
  }

  private pressFrame() {
    return { v: 1 as const, type: 'PRESS' as const, sessionId: this.sessionId!, pressSeq: this.pending!.pressSeq, need: this.pending!.need };
  }

  private track(down: boolean, wasDown: boolean, nowMs: number, which: 'cycle' | 'confirm'): void {
    const stable = which === 'cycle' ? 'cycleStableSince' : 'confirmStableSince';
    if (down && !wasDown) this[stable] = nowMs;
    if (!down) this[stable] = null;
  }
}
