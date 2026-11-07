/**
 * RelayAid v1 external contracts.
 * JSON boundaries use strings for identifiers, versions, epochs, and sequences.
 * Station ownership is never taken from a client payload.
 */

export const SCHEMA_VERSION = 1 as const;
export const POLICY_ID = 'coverage-wait-travel-v1' as const;
export const SOLVER_VERSION = 'mcmf-coverage-wait-travel-1' as const;
export const MAX_REQUESTS = 100;
export const MAX_RESOURCE_POOLS = 30;
export const MAX_FREE_UNITS = 100;
export const MAX_TRAVEL_SECONDS = 3600;
export const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
export const EXPLANATION_MAX = 2000;
export const SERIAL_FRAME_MAX_BYTES = 256;
export const U64_MAX = '18446744073709551615';

export const NEED_TYPES = ['WATER', 'CHARGING'] as const;
export type NeedType = (typeof NEED_TYPES)[number];

export const REQUEST_STATES = ['NEW', 'ACKNOWLEDGED', 'ASSIGNED', 'COMPLETED', 'CANCELLED'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const TRANSPORT_STATES = ['PENDING', 'DELIVERED', 'CONFLICT', 'RETRYABLE_ERROR'] as const;
export type TransportState = (typeof TRANSPORT_STATES)[number];

export const ROLES = ['ADMIN', 'COORDINATOR', 'VOLUNTEER', 'STATION', 'WORKER'] as const;
export type Role = (typeof ROLES)[number];

export const ACCOUNTING_MODES = ['CONSUMABLE', 'REUSABLE'] as const;
export type AccountingMode = (typeof ACCOUNTING_MODES)[number];

export const PLAN_STATES = ['PROPOSED', 'APPROVED', 'REJECTED'] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export const RUN_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_MODES = ['DETERMINISTIC', 'NEMOTRON'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const ASSIGNMENT_STATES = ['ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

export const RESERVATION_STATES = ['HELD', 'CONSUMED', 'RELEASED'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export const REASON_CODES = [
  'NOT_ACKNOWLEDGED',
  'NO_CATEGORY_RESOURCE',
  'CAPABILITY_UNAVAILABLE',
  'RESOURCE_UNAVAILABLE',
  'CAPACITY_EXHAUSTED',
  'CAPACITY_COMPETITION',
  'INPUT_INCOMPLETE',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const TOOL_NAMES = [
  'readRequests',
  'readResources',
  'solveAssignment',
  'compareWithBaseline',
  'explainUnmatched',
  'createProposedPlan',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_SCHEMA',
  'UNSUPPORTED_CATEGORY',
  'IDEMPOTENCY_CONFLICT',
  'STALE_VERSION',
  'INVALID_TRANSITION',
  'STALE_PLAN',
  'EXPIRED_PLAN',
  'CAPACITY_EXCEEDED',
  'BATCH_LIMIT',
  'NOT_FOUND',
  'REQUEST_UNAVAILABLE',
  'STATION_DISABLED',
  'LOCAL_STORAGE_FAILED',
  'STORAGE_FULL',
  'NETWORK_UNAVAILABLE',
  'UNKNOWN_RESULT',
  'AUTH_REQUIRED',
  'INPUT_INCOMPLETE',
  'MODEL_UNAVAILABLE',
  'TOOL_REJECTED',
  'RUN_FAILED',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEQUENCE_RE = /^[1-9][0-9]{0,19}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export class ContractError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export type SubmitRequestV1 = {
  schemaVersion: 1;
  commandId: string;
  requestId: string;
  localSequence: string;
  needType: NeedType;
  units: 1;
  deviceCreatedAt: string;
};

export type ReceiptV1 = {
  commandId: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  requestId?: string;
  requestVersion?: string;
  errorCode?: string;
  commandType?: string;
};

export type SnapshotRequest = {
  requestId: string;
  version: string;
  state: RequestState;
  needType: NeedType;
  units: 1;
  receivedAt: string;
  zoneId: string;
  requiresStepFree: boolean;
  stationId?: string;
};

export type SnapshotResource = {
  resourceId: string;
  version: string;
  needType: NeedType;
  accountingMode: AccountingMode;
  totalCapacity: number;
  reservedUnits: number;
  consumedUnits: number;
  available: boolean;
  stepFree: boolean;
  zoneId: string;
};

export type TravelSeconds = {
  from: string;
  to: string;
  seconds: number;
};

export type AllocationSnapshotInput = {
  schemaVersion: 1;
  snapshotId: string;
  shelterId: string;
  allocationEpoch: string;
  policyId: typeof POLICY_ID;
  capturedAt: string;
  requests: SnapshotRequest[];
  resources: SnapshotResource[];
  travelSeconds: TravelSeconds[];
  omittedCount?: number;
};

export type Allocation = {
  requestId: string;
  resourceId: string;
  units: 1;
  travelSeconds: number;
  waitingRank: number;
};

export type UnmatchedReason = {
  requestId: string;
  reason: ReasonCode;
  evidenceIds: string[];
  detail: string;
};

export type ObjectiveTotals = {
  matchCount: number;
  waitingRankSum: number;
  travelSecondsSum: number;
};

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isLabel(value: string): boolean {
  return LABEL_RE.test(value);
}

export function isDecimalSequence(value: string): boolean {
  if (!SEQUENCE_RE.test(value)) return false;
  if (value.length < U64_MAX.length) return true;
  if (value.length > U64_MAX.length) return false;
  return value <= U64_MAX;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of entries) out[key] = sortValue(inner);
    return out;
  }
  return value;
}

export function shortRef(requestId: string, needType: NeedType): string {
  const prefix = needType === 'WATER' ? 'W' : 'C';
  const compact = requestId.replace(/[^a-zA-Z0-9]/g, '');
  const tail = (compact.slice(-4) || '0000').toUpperCase();
  return `${prefix}-${tail}`;
}

export function parseDeviceTime(value: string): string {
  if (typeof value !== 'string' || value.length > 40) {
    throw new ContractError('INVALID_SCHEMA', 'deviceCreatedAt is not a date-time.');
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new ContractError('INVALID_SCHEMA', 'deviceCreatedAt is not a date-time.');
  return new Date(time).toISOString();
}

export function validateSubmitRequest(input: unknown): SubmitRequestV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractError('INVALID_SCHEMA', 'Submit envelope must be an object.');
  }
  const record = input as Record<string, unknown>;
  const allowed = ['schemaVersion', 'commandId', 'requestId', 'localSequence', 'needType', 'units', 'deviceCreatedAt'];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ContractError('INVALID_SCHEMA', `Unknown field ${key}.`);
  }
  for (const key of allowed) {
    if (!(key in record)) throw new ContractError('INVALID_SCHEMA', `Missing ${key}.`);
  }
  if (record.schemaVersion !== 1) throw new ContractError('INVALID_SCHEMA', 'Unsupported schema version.');
  if (typeof record.commandId !== 'string' || !isUuid(record.commandId)) {
    throw new ContractError('INVALID_SCHEMA', 'commandId must be a UUID.');
  }
  if (typeof record.requestId !== 'string' || !isUuid(record.requestId)) {
    throw new ContractError('INVALID_SCHEMA', 'requestId must be a UUID.');
  }
  if (typeof record.localSequence !== 'string' || !isDecimalSequence(record.localSequence)) {
    throw new ContractError('INVALID_SCHEMA', 'localSequence is outside the supported range.');
  }
  if (record.needType !== 'WATER' && record.needType !== 'CHARGING') {
    throw new ContractError('UNSUPPORTED_CATEGORY', 'Only WATER and CHARGING are accepted.');
  }
  if (record.units !== 1) throw new ContractError('INVALID_SCHEMA', 'units must be 1.');
  const deviceCreatedAt = parseDeviceTime(String(record.deviceCreatedAt));
  return {
    schemaVersion: 1,
    commandId: record.commandId.toLowerCase(),
    requestId: record.requestId.toLowerCase(),
    localSequence: record.localSequence,
    needType: record.needType,
    units: 1,
    deviceCreatedAt,
  };
}

export function submitCanonical(input: SubmitRequestV1): string {
  return canonicalJson({
    schemaVersion: input.schemaVersion,
    commandId: input.commandId,
    requestId: input.requestId,
    localSequence: input.localSequence,
    needType: input.needType,
    units: input.units,
    deviceCreatedAt: input.deviceCreatedAt,
  });
}

export type SerialPress = {
  v: 1;
  type: 'PRESS';
  sessionId: string;
  pressSeq: number;
  need: NeedType;
};

export type SerialHello = {
  v: 1;
  type: 'HELLO';
  sessionId: string | null;
  booted: boolean;
  pendingPressSeq: number | null;
};

export function parseSerialFrame(line: string): Record<string, unknown> {
  if (Buffer.byteLength(line) > SERIAL_FRAME_MAX_BYTES) {
    throw new ContractError('INVALID_SCHEMA', 'Serial frame exceeds 256 bytes.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ContractError('INVALID_SCHEMA', 'Serial frame is not JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ContractError('INVALID_SCHEMA', 'Serial frame must be an object.');
  }
  return parsed as Record<string, unknown>;
}

export function validatePressFrame(value: Record<string, unknown>): SerialPress {
  const allowed = ['v', 'type', 'sessionId', 'pressSeq', 'need'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ContractError('INVALID_SCHEMA', `Unknown serial field ${key}.`);
  }
  if (value.v !== 1 || value.type !== 'PRESS') throw new ContractError('INVALID_SCHEMA', 'Not a PRESS frame.');
  if (typeof value.sessionId !== 'string' || !isUuid(value.sessionId)) {
    throw new ContractError('INVALID_SCHEMA', 'sessionId must be a UUID.');
  }
  if (typeof value.pressSeq !== 'number' || !Number.isInteger(value.pressSeq) || value.pressSeq < 1 || value.pressSeq > 1_000_000_000) {
    throw new ContractError('INVALID_SCHEMA', 'pressSeq is invalid.');
  }
  if (value.need !== 'WATER' && value.need !== 'CHARGING') {
    throw new ContractError('UNSUPPORTED_CATEGORY', 'PRESS need must be WATER or CHARGING.');
  }
  return {
    v: 1,
    type: 'PRESS',
    sessionId: value.sessionId.toLowerCase(),
    pressSeq: value.pressSeq,
    need: value.need,
  };
}

export function encodeFrame(value: unknown): string {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > SERIAL_FRAME_MAX_BYTES) {
    throw new ContractError('INVALID_SCHEMA', 'Outbound frame exceeds 256 bytes.');
  }
  return `${line}\n`;
}

export function bumpDecimal(value: string): string {
  if (!/^[0-9]+$/.test(value)) throw new ContractError('INVALID_SCHEMA', 'Version is not decimal.');
  let carry = 1;
  const digits = value.split('');
  for (let i = digits.length - 1; i >= 0 && carry; i -= 1) {
    const next = Number(digits[i]) + carry;
    digits[i] = String(next % 10);
    carry = next >= 10 ? 1 : 0;
  }
  if (carry) digits.unshift('1');
  return digits.join('').replace(/^0+(?=\d)/, '');
}

export function cmpDecimal(a: string, b: string): number {
  const as = a.replace(/^0+(?=\d)/, '');
  const bs = b.replace(/^0+(?=\d)/, '');
  if (as.length !== bs.length) return as.length - bs.length;
  if (as === bs) return 0;
  return as < bs ? -1 : 1;
}

export function toolSchema(name: string): { required: string[]; allowed: string[] } | null {
  switch (name) {
    case 'readRequests':
    case 'readResources':
      return { required: ['snapshotId'], allowed: ['snapshotId'] };
    case 'solveAssignment':
      return { required: ['snapshotId', 'policyId'], allowed: ['snapshotId', 'policyId'] };
    case 'compareWithBaseline':
      return { required: ['solutionId'], allowed: ['solutionId'] };
    case 'explainUnmatched':
      return { required: ['solutionId', 'requestIds'], allowed: ['solutionId', 'requestIds'] };
    case 'createProposedPlan':
      return { required: ['solutionId', 'explanation'], allowed: ['solutionId', 'explanation'] };
    default:
      return null;
  }
}

export const DEMO_IDS = {
  shelterId: 'demo-shelter',
  stationId: 'station-lobby',
  requests: {
    r1: '11111111-1111-4111-8111-111111111101',
    r2: '11111111-1111-4111-8111-111111111102',
    r3: '11111111-1111-4111-8111-111111111103',
    r4: '11111111-1111-4111-8111-111111111104',
    r5: '11111111-1111-4111-8111-111111111105',
  },
  identities: {
    admin: 'identity-admin',
    coordinator: 'identity-coordinator',
    station: 'identity-station',
    volunteer: 'identity-volunteer',
    worker: 'identity-worker',
    outsider: 'identity-outsider',
  },
} as const;
