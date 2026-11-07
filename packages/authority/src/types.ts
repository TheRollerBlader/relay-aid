import type {
  AccountingMode,
  Allocation,
  AssignmentState,
  NeedType,
  ObjectiveTotals,
  PlanState,
  ReasonCode,
  RequestState,
  ReservationState,
  Role,
  RunMode,
  RunStatus,
  UnmatchedReason,
} from '@relayaid/contracts';

export type Principal = {
  identity: string;
  role: Role;
  shelterId: string;
  enabled: boolean;
  version: string;
};

export type Station = {
  stationId: string;
  principalIdentity: string;
  installationId: string;
  shelterId: string;
  label: string;
  zoneId: string;
  allowedCategories: NeedType[];
  enabled: boolean;
  version: string;
};

export type RequestRow = {
  requestId: string;
  stationId: string;
  shelterId: string;
  localSequence: string;
  needType: NeedType;
  units: 1;
  requiresStepFree: boolean;
  zoneId: string;
  receivedAt: string;
  deviceCreatedAt: string;
  state: RequestState;
  version: string;
  activeAssignmentId: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  linkedParentId: string | null;
  canonicalSubmit: string | null;
};

export type RequestEvent = {
  eventId: string;
  requestId: string;
  version: string;
  kind: string;
  actorIdentity: string;
  serverTime: string;
  reasonCode: string | null;
  commandId: string;
};

export type ResourceRow = {
  resourceId: string;
  shelterId: string;
  label: string;
  needType: NeedType;
  accountingMode: AccountingMode;
  totalCapacity: number;
  reservedUnits: number;
  consumedUnits: number;
  available: boolean;
  stepFree: boolean;
  zoneId: string;
  version: string;
};

export type Volunteer = {
  principalIdentity: string;
  shelterId: string;
  displayLabel: string;
  available: boolean;
  activeAssignmentId: string | null;
  version: string;
};

export type AllocationControl = {
  shelterId: string;
  allocationEpoch: string;
  policyVersion: string;
};

export type AllocationSnapshot = {
  snapshotId: string;
  shelterId: string;
  epoch: string;
  policyVersion: string;
  policyId: string;
  createdAt: string;
  expiresAt: string;
  omittedCount: number;
  canonicalHash: string;
  requests: Array<{
    requestId: string;
    version: string;
    state: RequestState;
    needType: NeedType;
    units: 1;
    receivedAt: string;
    zoneId: string;
    requiresStepFree: boolean;
    stationId: string;
  }>;
  resources: ResourceRow[];
  travelSeconds: Array<{ from: string; to: string; seconds: number }>;
};

export type PlanAllocation = Allocation & {
  requestVersion: string;
  resourceVersion: string;
};

export type ProposedPlan = {
  planId: string;
  snapshotId: string;
  shelterId: string;
  proposerIdentity: string;
  allocations: PlanAllocation[];
  unmatched: UnmatchedReason[];
  baselineMatchCount: number;
  baselineWaitingRankSum: number;
  baselineTravelSeconds: number;
  solverVersion: string;
  objective: ObjectiveTotals;
  explanation: string;
  mode: RunMode | 'MANUAL';
  modelId: string | null;
  state: PlanState;
  version: string;
  createdAt: string;
};

export type ProposalRun = {
  runId: string;
  shelterId: string;
  requestedBy: string;
  snapshotId: string;
  mode: RunMode;
  status: RunStatus;
  workerIdentity: string | null;
  leaseExpiresAt: string | null;
  resultPlanId: string | null;
  errorCode: string | null;
  commandId: string;
};

export type Assignment = {
  assignmentId: string;
  requestId: string;
  resourceId: string;
  planId: string;
  shelterId: string;
  units: 1;
  state: AssignmentState;
  volunteerIdentity: string | null;
  version: string;
};

export type Reservation = {
  reservationId: string;
  assignmentId: string;
  resourceId: string;
  units: 1;
  state: ReservationState;
  version: string;
};

export type CommandReceipt = {
  receiptKey: string;
  callerIdentity: string;
  commandId: string;
  commandType: string;
  canonicalInput: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  entityId: string | null;
  entityVersion: string | null;
  errorCode: string | null;
  serverTime: string;
};

export type Approval = {
  approvalId: string;
  planId: string;
  actorIdentity: string;
  serverTime: string;
  commandId: string;
  epoch: string;
  result: string;
};

export type AuditEvent = {
  auditId: string;
  shelterId: string;
  action: string;
  actorIdentity: string;
  targetId: string;
  reason: string | null;
  serverTime: string;
  commandId: string | null;
};

export type AuthorityState = {
  shelterName: string;
  principals: Record<string, Principal>;
  stations: Record<string, Station>;
  requests: Record<string, RequestRow>;
  events: RequestEvent[];
  resources: Record<string, ResourceRow>;
  volunteers: Record<string, Volunteer>;
  controls: Record<string, AllocationControl>;
  snapshots: Record<string, AllocationSnapshot>;
  plans: Record<string, ProposedPlan>;
  runs: Record<string, ProposalRun>;
  assignments: Record<string, Assignment>;
  reservations: Record<string, Reservation>;
  receipts: Record<string, CommandReceipt>;
  approvals: Approval[];
  audits: AuditEvent[];
  travelSeconds: Array<{ shelterId: string; from: string; to: string; seconds: number }>;
};

export function emptyState(): AuthorityState {
  return {
    shelterName: 'North Hall Shelter',
    principals: {},
    stations: {},
    requests: {},
    events: [],
    resources: {},
    volunteers: {},
    controls: {},
    snapshots: {},
    plans: {},
    runs: {},
    assignments: {},
    reservations: {},
    receipts: {},
    approvals: [],
    audits: [],
    travelSeconds: [],
  };
}
