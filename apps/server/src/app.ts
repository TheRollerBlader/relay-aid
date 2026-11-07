import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Authority, type AllocationSnapshot } from '@relayaid/authority';
import {
  DEMO_IDS,
  POLICY_ID,
  shortRef,
  type AllocationSnapshotInput,
  type NeedType,
  type SubmitRequestV1,
} from '@relayaid/contracts';
import { DeterministicModel, createNemotronClient, nemotronConfigFromEnv, runToolLoop } from '@relayaid/proposal-worker';
import { SerialBridge, StationStore } from '@relayaid/station';

const ROLES = {
  admin: DEMO_IDS.identities.admin,
  coordinator: DEMO_IDS.identities.coordinator,
  station: DEMO_IDS.identities.station,
  volunteer: DEMO_IDS.identities.volunteer,
} as const;

type DemoRole = keyof typeof ROLES;

export type RunningServer = {
  url: string;
  close: () => Promise<void>;
};

export async function startServer(options?: { port?: number; bind?: string; dataDir?: string; webDist?: string }): Promise<RunningServer> {
  const dataDir = options?.dataDir ?? process.env.STATION_DATA_DIR ?? join(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'authority.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS authority_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, role TEXT NOT NULL, identity TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const saved = db.prepare('SELECT json FROM authority_state WHERE id = 1').get() as { json: string } | undefined;
  const authority = saved ? new Authority(JSON.parse(saved.json) as ConstructorParameters<typeof Authority>[0]) : Authority.demo();
  const persist = () => {
    const json = JSON.stringify(authority.state);
    db.prepare(
      `INSERT INTO authority_state (id, json) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    ).run(json);
  };
  if (!saved) persist();

  const station = StationStore.open(join(dataDir, 'station.sqlite'));
  let uplink = true;
  let selectedNeed: NeedType = 'WATER';
  let planning = false;
  const serial = openSerial(station);

  const nemotron = nemotronConfigFromEnv(process.env, (file) => {
    try {
      if (!existsSync(file)) return null;
      const key = readFileSync(file, 'utf8').trim();
      return key || null;
    } catch {
      return null;
    }
  });

  let syncing: Promise<unknown> = Promise.resolve();
  const sync = setInterval(() => {
    syncing = station.syncOnce(
      {
        submit: async (payload: SubmitRequestV1) => {
          const receipt = authority.submitRequest(DEMO_IDS.identities.station, payload);
          persist();
          return receipt;
        },
        statuses: async () =>
          authority.myStationRequests(DEMO_IDS.identities.station).requests.map((request) => ({
            requestId: request.requestId,
            version: request.version,
            state: request.state,
          })),
      },
      { uplink, nowMs: Date.now(), jitter: Math.random() },
    );
  }, 1000);
  sync.unref?.();

  const webDist = options?.webDist ?? join(process.cwd(), 'apps/web/dist');
  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      const coded = error as { code?: string; message?: string };
      const code = coded.code ?? 'RUN_FAILED';
      const status = code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'AUTH_REQUIRED' ? 403 : 400;
      send(res, status, { errorCode: code, message: coded.message ?? 'Request failed.' });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/health') {
      send(res, 200, health());
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      serveStatic(req, res, webDist, url.pathname);
      return;
    }
    if (req.method === 'POST' && !guardMutation(req, res)) return;
    if (req.method === 'POST' && url.pathname === '/api/session') {
      const body = (await readJson(req)) as { role?: string };
      if (!body.role || !(body.role in ROLES)) {
        send(res, 400, { errorCode: 'INVALID_SCHEMA', message: 'Choose station, coordinator, volunteer, or admin.' });
        return;
      }
      const role = body.role as DemoRole;
      const token = randomUUID();
      db.prepare('INSERT INTO sessions (token, role, identity, created_at) VALUES (?, ?, ?, ?)').run(
        token,
        role,
        ROLES[role],
        new Date().toISOString(),
      );
      res.setHeader('set-cookie', cookie(token, req));
      send(res, 200, { role, shelter: authority.state.shelterName });
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/session') {
      const token = readCookie(req, 'relayaid_session');
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      res.setHeader('set-cookie', 'relayaid_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      send(res, 200, { ok: true });
      return;
    }
    const session = currentSession(req);
    if (req.method === 'GET' && url.pathname === '/api/session') {
      send(res, 200, session ? { role: session.role, shelter: authority.state.shelterName } : { role: null });
      return;
    }
    if (!session) {
      send(res, 401, { errorCode: 'AUTH_REQUIRED', message: 'Choose a role to continue.' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/station') {
      requireRole(session, 'station');
      send(res, 200, stationView());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/station/selection') {
      requireRole(session, 'station');
      const body = (await readJson(req)) as { need?: string };
      if (body.need !== 'WATER' && body.need !== 'CHARGING') {
        send(res, 400, { errorCode: 'UNSUPPORTED_CATEGORY', message: 'Choose water or charging.' });
        return;
      }
      selectedNeed = body.need;
      send(res, 200, stationView());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/station/confirm') {
      requireRole(session, 'station');
      const body = (await readJson(req)) as { source?: string };
      const source = body.source === 'keyboard' ? 'keyboard' : 'pointer';
      const saved = station.confirmSoftwarePress(selectedNeed, source, new Date().toISOString());
      if (!saved.ok) {
        send(res, 503, { errorCode: 'LOCAL_STORAGE_FAILED', message: 'Not saved. The station could not write this request.', station: stationView() });
        return;
      }
      send(res, 200, { saved: true, duplicate: saved.duplicate, requestId: saved.requestId, station: stationView() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/station/uplink') {
      requireRole(session, 'station');
      const body = (await readJson(req)) as { connected?: boolean };
      uplink = body.connected !== false;
      send(res, 200, stationView());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/views/queue') {
      requireRole(session, 'coordinator', 'admin');
      send(res, 200, authority.coordinatorRequests(session.identity));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/views/resources') {
      requireRole(session, 'coordinator', 'admin');
      send(res, 200, authority.coordinatorResources(session.identity));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/views/plans') {
      requireRole(session, 'coordinator', 'admin');
      send(res, 200, authority.coordinatorPlans(session.identity));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/views/activity') {
      requireRole(session, 'coordinator', 'admin');
      send(res, 200, authority.coordinatorActivity(session.identity));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/views/volunteer') {
      requireRole(session, 'volunteer');
      send(res, 200, authority.myVolunteerAssignments(session.identity));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/commands/deterministic-plan') {
      requireRole(session, 'coordinator');
      const body = (await readJson(req)) as { commandId?: string };
      send(res, 200, await plan(session.identity, 'DETERMINISTIC', body.commandId ?? randomUUID()));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/commands/nemotron-plan') {
      requireRole(session, 'coordinator');
      const body = (await readJson(req)) as { commandId?: string };
      send(res, 200, await plan(session.identity, 'NEMOTRON', body.commandId ?? randomUUID()));
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/commands/')) {
      const name = url.pathname.slice('/api/commands/'.length);
      const body = await readJson(req);
      const receipt = dispatch(session, name, body);
      persist();
      send(res, receipt.outcome === 'ACCEPTED' ? 200 : 409, receipt);
      return;
    }
    send(res, 404, { errorCode: 'NOT_FOUND', message: 'No such route.' });
  }

function dispatch(session: { role: DemoRole; identity: string }, name: string, body: unknown) {
  const record = (body ?? {}) as never;
    if (name === 'acknowledge' || name === 'cancel' || name === 'requirements' || name === 'resource' || name === 'manual-plan' || name === 'approve' || name === 'reject' || name === 'attach' || name === 'linked') {
      requireRole(session, 'coordinator', 'admin');
    }
    if (name === 'complete') requireRole(session, 'coordinator', 'volunteer', 'admin');
    if (name === 'reset') requireRole(session, 'admin');
    switch (name) {
      case 'acknowledge':
        return authority.acknowledgeRequest(session.identity, record);
      case 'cancel':
        return authority.cancelRequest(session.identity, record);
      case 'requirements':
        return authority.setRequestRequirements(session.identity, record);
      case 'resource':
        return authority.updateResource(session.identity, record);
      case 'manual-plan':
        return authority.createManualPlan(session.identity, record);
      case 'approve':
        return authority.approvePlan(session.identity, record);
      case 'reject':
        return authority.rejectPlan(session.identity, record);
      case 'attach':
        return authority.attachVolunteer(session.identity, record);
      case 'complete':
        return authority.completeAssignment(session.identity, record);
      case 'linked':
        return authority.createLinkedRequest(session.identity, record);
      case 'reset': {
        const receipt = authority.resetDemo(session.identity, record as { commandId: string; confirm: string });
        persist();
        return receipt;
      }
      default:
        throw Object.assign(new Error('Unknown command.'), { code: 'NOT_FOUND' });
    }
  }

  async function plan(identity: string, mode: 'DETERMINISTIC' | 'NEMOTRON', commandId: string) {
    if (planning) return { ok: false, errorCode: 'RUN_FAILED', message: 'A proposal is already running.' };
    planning = true;
    try {
      const started = authority.startProposalRun(identity, { commandId, mode });
      persist();
      if (mode === 'NEMOTRON' && !nemotron) {
        authority.claimProposalRun(DEMO_IDS.identities.worker, { runId: started.runId, commandId: randomUUID() });
        authority.failProposalRun(DEMO_IDS.identities.worker, { runId: started.runId, commandId: randomUUID(), errorCode: 'MODEL_UNAVAILABLE' });
        persist();
        return {
          ok: false,
          errorCode: 'MODEL_UNAVAILABLE',
          message: 'No live Nemotron endpoint is configured. Deterministic planning still works.',
          runId: started.runId,
        };
      }
      const snapshot = authority.readSnapshot(DEMO_IDS.identities.worker, started.snapshotId);
      if (!snapshot) return { ok: false, errorCode: 'NOT_FOUND', message: 'Snapshot missing.' };
      authority.claimProposalRun(DEMO_IDS.identities.worker, { runId: started.runId, commandId: randomUUID() });
      const planId = randomUUID();
      const model = mode === 'NEMOTRON' && nemotron ? createNemotronClient(nemotron) : new DeterministicModel();
      const loop = await runToolLoop({
        snapshot: toSnapshotInput(snapshot),
        model,
        persist: (draft) => {
          const receipt = authority.createProposedPlan(DEMO_IDS.identities.worker, {
            planId,
            runId: started.runId,
            commandId: randomUUID(),
            allocations: draft.allocations.map((allocation) => ({
              ...allocation,
              requestVersion: snapshot.requests.find((request) => request.requestId === allocation.requestId)?.version ?? '0',
              resourceVersion: snapshot.resources.find((resource) => resource.resourceId === allocation.resourceId)?.version ?? '0',
            })),
            unmatched: draft.unmatched,
            objective: draft.objective,
            baseline: draft.baseline,
            solverVersion: draft.solverVersion,
            explanation: draft.explanation,
            modelId: draft.modelId,
          });
          if (receipt.outcome !== 'ACCEPTED') {
            throw Object.assign(new Error(receipt.errorCode ?? 'Proposal rejected.'), { code: receipt.errorCode ?? 'RUN_FAILED' });
          }
        },
      });
      if (!loop.ok) {
        const run = authority.state.runs[started.runId];
        if (run?.status === 'RUNNING') {
          authority.failProposalRun(DEMO_IDS.identities.worker, {
            runId: started.runId,
            commandId: randomUUID(),
            errorCode: loop.errorCode ?? 'RUN_FAILED',
          });
        }
      }
      persist();
      return {
        ok: loop.ok,
        errorCode: loop.errorCode,
        planId: loop.ok ? planId : undefined,
        runId: started.runId,
        omittedCount: started.omittedCount,
        trace: loop.trace,
        liveModel: model.live,
        modelId: model.id,
      };
    } finally {
      planning = false;
    }
  }

  function health() {
    return {
      ok: true,
      storage: 'ok',
      serial: serial.connected ? 'connected' : 'absent',
      uplink,
      backend: 'local-authority',
      spacetime: 'not-connected',
      nemotron: nemotron ? 'configured' : 'unavailable',
      scenario: process.env.DEMO_SCENARIO_ID ?? 'demo-coverage-001',
      shelter: authority.state.shelterName,
      policyId: POLICY_ID,
      pendingLocal: station.pendingCount(),
    };
  }

  function stationView() {
    const rows = station.listOutbox().slice().reverse();
    const requests = rows.map((row) => {
      const payload = JSON.parse(row.payload) as SubmitRequestV1;
      const display = station.display(row.request_id);
      return {
        requestId: row.request_id,
        shortRef: shortRef(row.request_id, payload.needType),
        needType: payload.needType,
        source: row.source,
        transport: row.transport_state,
        lastError: row.last_error === '__in_flight__' ? null : row.last_error,
        createdAt: row.created_at,
        code: display.code,
        copy: display.copy,
        server: station.cacheFor(row.request_id),
      };
    });
    return {
      shelter: authority.state.shelterName,
      installationId: station.installationId,
      selectedNeed,
      uplink,
      serial: serial.connected ? 'connected' : 'absent',
      storage: 'ok',
      pendingCount: station.pendingCount(),
      requests,
      focus: requests[0] ?? null,
      serverTime: new Date().toISOString(),
    };
  }

  function currentSession(req: IncomingMessage): { role: DemoRole; identity: string } | null {
    const token = readCookie(req, 'relayaid_session');
    if (!token) return null;
    const row = db.prepare('SELECT role, identity FROM sessions WHERE token = ?').get(token) as { role: DemoRole; identity: string } | undefined;
    return row ?? null;
  }

  const port = options?.port ?? Number(process.env.RELAYAID_PORT ?? process.env.PORT ?? 4317);
  const bind = options?.bind ?? process.env.RELAYAID_BIND ?? '127.0.0.1';

  await new Promise<void>((resolveListen) => server.listen(port, bind, () => resolveListen()));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () =>
      new Promise((resolveClose) => {
        clearInterval(sync);
        void syncing.finally(() => {
          serial.close();
          station.close();
          db.close();
          server.close(() => resolveClose());
        });
      }),
  };
}

function toSnapshotInput(snapshot: AllocationSnapshot): AllocationSnapshotInput {
  return {
    schemaVersion: 1,
    snapshotId: snapshot.snapshotId,
    shelterId: snapshot.shelterId,
    allocationEpoch: snapshot.epoch,
    policyId: POLICY_ID,
    capturedAt: snapshot.createdAt,
    requests: snapshot.requests,
    resources: snapshot.resources,
    travelSeconds: snapshot.travelSeconds,
    omittedCount: snapshot.omittedCount,
  };
}

function requireRole(session: { role: DemoRole }, ...roles: DemoRole[]): void {
  if (!roles.includes(session.role)) throw Object.assign(new Error('Not allowed.'), { code: 'FORBIDDEN' });
}

function guardMutation(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers['x-relayaid-request'] !== '1') {
    send(res, 403, { errorCode: 'FORBIDDEN', message: 'Missing request header.' });
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    let hostname = '';
    try {
      hostname = new URL(origin).hostname;
    } catch {
      send(res, 403, { errorCode: 'FORBIDDEN', message: 'Cross-site request blocked.' });
      return false;
    }
    const expected = req.headers.host;
    const local = hostname === '127.0.0.1' || hostname === 'localhost';
    if (expected && originHost(origin) !== expected && !local) {
      send(res, 403, { errorCode: 'FORBIDDEN', message: 'Cross-site request blocked.' });
      return false;
    }
  }
  return true;
}

function originHost(origin: string): string {
  return new URL(origin).host;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(Object.assign(new Error('Request body is too large.'), { code: 'INVALID_SCHEMA' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Body must be JSON.'), { code: 'INVALID_SCHEMA' }));
      }
    });
    req.on('error', reject);
  });
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function cookie(token: string, req: IncomingMessage): string {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `relayaid_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  });
  res.end(payload);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, dist: string, pathname: string): void {
  if (!existsSync(dist)) {
    send(res, 404, { errorCode: 'NOT_FOUND', message: 'UI build is not present. Use the dev server.' });
    return;
  }
  const root = resolve(dist);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(root, normalize(`.${requested}`));
  const file = existsSync(target) && statSync(target).isFile() ? target : resolve(root, 'index.html');
  if (!file.startsWith(root)) {
    send(res, 403, { errorCode: 'FORBIDDEN', message: 'Not allowed.' });
    return;
  }
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  };
  const data = readFileSync(file);
  res.writeHead(req.method === 'HEAD' ? 200 : 200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'content-length': data.length,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function openSerial(store: StationStore): { connected: boolean; close: () => void } {
  const device = process.env.SERIAL_DEVICE;
  if (!device || !existsSync(device)) return { connected: false, close: () => undefined };
  try {
    const reader = createReadStream(device, { encoding: 'utf8' });
    const writer = createWriteStream(device);
    const bridge = new SerialBridge(store, (frame) => {
      writer.write(frame);
    });
    let buffer = '';
    reader.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        bridge.onLine(line);
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > 1024) buffer = '';
    });
    const beat = setInterval(() => writer.write(JSON.stringify({ v: 1, type: 'HEARTBEAT' }) + '\n'), 1000);
    return {
      connected: true,
      close: () => {
        clearInterval(beat);
        reader.close();
        writer.end();
      },
    };
  } catch {
    return { connected: false, close: () => undefined };
  }
}
