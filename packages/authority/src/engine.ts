import { randomUUID } from 'node:crypto';
import {
  bumpDecimal,
  canonicalJson,
  DEMO_IDS,
  EXPLANATION_MAX,
  isUuid,
  MAX_FREE_UNITS,
  MAX_REQUESTS,
  MAX_RESOURCE_POOLS,
  POLICY_ID,
  REASON_CODES,
  SNAPSHOT_TTL_MS,
  SOLVER_VERSION,
  submitCanonical,
  validateSubmitRequest,
  type ErrorCode,
  type NeedType,
  type ReceiptV1,
  type Role,
  type RunMode,
} from '@relayaid/contracts';
import { assertCapacityInvariant, assertTransition, capabilityMatches, completeUnits, freeUnits, releaseUnits, reserveUnits } from '@relayaid/domain';
import { solve, validateAllocations, SolverError } from '@relayaid/solver';
import { buildDemoState, sha256 } from './demo';
import type {
  AllocationSnapshot,
  Assignment,
  AuditEvent,
  AuthorityState,
  CommandReceipt,
  PlanAllocation,
  Principal,
  ProposedPlan,
  RequestRow,
  ResourceRow,
  Station,
} from './types';

export class AuthorityError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AuthorityError';
    this.code = code;
  }
}

type Clock = () => string;

const LEASE_MS = 30_000;

export class Authority {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    public state: AuthorityState,
    private readonly now: Clock = () => new Date().toISOString(),
    private readonly id: () => string = randomUUID,
  ) {}

  static demo(now?: Clock, id?: () => string): Authority {
    return new Authority(buildDemoState(), now, id);
  }

  /** Serialize reducer transactions the way a database would. */
  run<T>(fn: () => T): Promise<T> {
    const next = this.tail.then(() => this.transaction(fn));
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  transaction<T>(fn: () => T): T {
    const snapshot = structuredClone(this.state);
    try {
      return fn();
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  private actor(identity: string, roles?: Role[]): Principal {
    const principal = this.state.principals[identity];
    if (!principal || !principal.enabled) {
      throw new AuthorityError('UNAUTHORIZED', 'Not allowed.');
    }
    if (roles && !roles.includes(principal.role)) {
      throw new AuthorityError('FORBIDDEN', 'Not allowed.');
    }
    return principal;
  }

  private stationFor(identity: string): Station {
    const principal = this.actor(identity, ['STATION']);
    const station = Object.values(this.state.stations).find((item) => item.principalIdentity === principal.identity);
    if (!station || !station.enabled) throw new AuthorityError('STATION_DISABLED', 'Station is disabled.');
    return station;
  }

  private control(shelterId: string) {
    const row = this.state.controls[shelterId];
    if (!row) throw new AuthorityError('NOT_FOUND', 'Shelter allocation control is missing.');
    return row;
  }

  private bumpEpoch(shelterId: string): void {
    const row = this.control(shelterId);
    row.allocationEpoch = bumpDecimal(row.allocationEpoch);
  }

  private audit(entry: Omit<AuditEvent, 'auditId' | 'serverTime'> & { serverTime?: string }): void {
    this.state.audits.push({
      auditId: this.id(),
      serverTime: entry.serverTime ?? this.now(),
      ...entry,
    });
    if (this.state.audits.length > 500) this.state.audits.splice(0, this.state.audits.length - 500);
  }

  private event(request: RequestRow, kind: string, actor: string, commandId: string, reasonCode: string | null = null): void {
    this.state.events.push({
      eventId: this.id(),
      requestId: request.requestId,
      version: request.version,
      kind,
      actorIdentity: actor,
      serverTime: this.now(),
      reasonCode,
      commandId,
    });
  }

  private receipt(input: Omit<CommandReceipt, 'receiptKey' | 'serverTime'>): CommandReceipt {
    const row: CommandReceipt = {
      ...input,
      receiptKey: `${input.callerIdentity}:${input.commandId}`,
      serverTime: this.now(),
    };
    this.state.receipts[row.receiptKey] = row;
    return row;
  }

  private prior(identity: string, commandType: string, commandId: string, canonical: string): CommandReceipt | null {
    if (!isUuid(commandId)) throw new AuthorityError('INVALID_SCHEMA', 'commandId must be a UUID.');
    const existing = this.state.receipts[`${identity}:${commandId}`];
    if (!existing) return null;
    if (existing.commandType !== commandType || existing.canonicalInput !== canonical) {
      throw new AuthorityError('IDEMPOTENCY_CONFLICT', 'This commandId was already used with a different payload.');
    }
    return existing;
  }

  private toReceipt(row: CommandReceipt): ReceiptV1 {
    return {
      commandId: row.commandId,
      outcome: row.outcome,
      requestId: row.entityId ?? undefined,
      requestVersion: row.entityVersion ?? undefined,
      errorCode: row.errorCode ?? undefined,
      commandType: row.commandType,
    };
  }

  private rejected(
    identity: string,
    commandType: string,
    commandId: string,
    canonical: string,
    errorCode: ErrorCode,
  ): ReceiptV1 {
    const row = this.receipt({
      callerIdentity: identity,
      commandId,
      commandType,
      canonicalInput: canonical,
      outcome: 'REJECTED',
      entityId: null,
      entityVersion: null,
      errorCode,
    });
    return this.toReceipt(row);
  }

  submitRequest(identity: string, input: unknown): ReceiptV1 {
    return this.transaction(() => {
      const station = this.stationFor(identity);
      const normalized = validateSubmitRequest(input);
      const canonical = submitCanonical(normalized);
      const prior = this.prior(identity, 'submitRequest', normalized.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      if (!station.allowedCategories.includes(normalized.needType)) {
        return this.rejected(identity, 'submitRequest', normalized.commandId, canonical, 'UNSUPPORTED_CATEGORY');
      }
      const immutable = canonicalJson({
        deviceCreatedAt: normalized.deviceCreatedAt,
        localSequence: normalized.localSequence,
        needType: normalized.needType,
        units: normalized.units,
      });
      const existing = this.state.requests[normalized.requestId];
      if (existing) {
        if (existing.stationId !== station.stationId) throw new AuthorityError('REQUEST_UNAVAILABLE', 'Not allowed.');
        if (existing.canonicalSubmit !== immutable) {
          throw new AuthorityError('IDEMPOTENCY_CONFLICT', 'This requestId was already used with a different payload.');
        }
        const row = this.receipt({
          callerIdentity: identity,
          commandId: normalized.commandId,
          commandType: 'submitRequest',
          canonicalInput: canonical,
          outcome: 'ACCEPTED',
          entityId: existing.requestId,
          entityVersion: existing.version,
          errorCode: null,
        });
        return this.toReceipt(row);
      }
      const sequenceOwner = Object.values(this.state.requests).find(
        (request) => request.stationId === station.stationId && request.localSequence === normalized.localSequence,
      );
      if (sequenceOwner) {
        return this.rejected(identity, 'submitRequest', normalized.commandId, canonical, 'IDEMPOTENCY_CONFLICT');
      }
      const created: RequestRow = {
        requestId: normalized.requestId,
        stationId: station.stationId,
        shelterId: station.shelterId,
        localSequence: normalized.localSequence,
        needType: normalized.needType,
        units: 1,
        requiresStepFree: false,
        zoneId: station.zoneId,
        receivedAt: this.now(),
        deviceCreatedAt: normalized.deviceCreatedAt,
        state: 'NEW',
        version: '1',
        activeAssignmentId: null,
        acknowledgedBy: null,
        acknowledgedAt: null,
        linkedParentId: null,
        canonicalSubmit: immutable,
      };
      this.state.requests[created.requestId] = created;
      this.event(created, 'CREATED', identity, normalized.commandId);
      const row = this.receipt({
        callerIdentity: identity,
        commandId: normalized.commandId,
        commandType: 'submitRequest',
        canonicalInput: canonical,
        outcome: 'ACCEPTED',
        entityId: created.requestId,
        entityVersion: created.version,
        errorCode: null,
      });
      this.audit({
        shelterId: station.shelterId,
        action: 'SUBMIT',
        actorIdentity: identity,
        targetId: created.requestId,
        reason: null,
        commandId: normalized.commandId,
      });
      return this.toReceipt(row);
    });
  }

  acknowledgeRequest(identity: string, input: { requestId: string; expectedVersion: string; commandId: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'acknowledgeRequest', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const request = this.requestInShelter(input.requestId, actor.shelterId);
      if (!request || request.version !== input.expectedVersion) {
        return this.rejected(identity, 'acknowledgeRequest', input.commandId, canonical, 'STALE_VERSION');
      }
      if (request.state !== 'NEW') {
        return this.rejected(identity, 'acknowledgeRequest', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      assertTransition(request.state, 'ACKNOWLEDGED');
      request.state = 'ACKNOWLEDGED';
      request.version = bumpDecimal(request.version);
      request.acknowledgedBy = identity;
      request.acknowledgedAt = this.now();
      this.bumpEpoch(actor.shelterId);
      this.event(request, 'ACKNOWLEDGED', identity, input.commandId);
      return this.accept(identity, 'acknowledgeRequest', input.commandId, canonical, request.requestId, request.version, 'ACKNOWLEDGE');
    });
  }

  cancelRequest(identity: string, input: { requestId: string; expectedVersion: string; commandId: string; reason: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'cancelRequest', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 200) {
        throw new AuthorityError('INVALID_SCHEMA', 'A cancellation reason is required.');
      }
      const request = this.requestInShelter(input.requestId, actor.shelterId);
      if (!request || request.version !== input.expectedVersion) {
        return this.rejected(identity, 'cancelRequest', input.commandId, canonical, 'STALE_VERSION');
      }
      if (request.state === 'COMPLETED' || request.state === 'CANCELLED') {
        return this.rejected(identity, 'cancelRequest', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      this.releaseActiveAssignment(request, actor.shelterId);
      request.state = 'CANCELLED';
      request.version = bumpDecimal(request.version);
      request.activeAssignmentId = null;
      this.bumpEpoch(actor.shelterId);
      this.event(request, 'CANCELLED', identity, input.commandId, 'CANCELLED');
      return this.accept(identity, 'cancelRequest', input.commandId, canonical, request.requestId, request.version, 'CANCEL', input.reason.trim());
    });
  }

  setRequestRequirements(
    identity: string,
    input: { requestId: string; expectedVersion: string; commandId: string; requiresStepFree: boolean; reason: string },
  ): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'setRequestRequirements', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      if (typeof input.requiresStepFree !== 'boolean' || typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 200) {
        throw new AuthorityError('INVALID_SCHEMA', 'Requirement update is incomplete.');
      }
      const request = this.requestInShelter(input.requestId, actor.shelterId);
      if (!request || request.version !== input.expectedVersion) {
        return this.rejected(identity, 'setRequestRequirements', input.commandId, canonical, 'STALE_VERSION');
      }
      if (request.state === 'COMPLETED' || request.state === 'CANCELLED' || request.state === 'ASSIGNED' || request.activeAssignmentId) {
        return this.rejected(identity, 'setRequestRequirements', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      request.requiresStepFree = input.requiresStepFree;
      request.version = bumpDecimal(request.version);
      this.bumpEpoch(actor.shelterId);
      this.event(request, 'REQUIREMENTS_SET', identity, input.commandId, input.requiresStepFree ? 'STEP_FREE' : 'STEP_FREE_CLEARED');
      return this.accept(identity, 'setRequestRequirements', input.commandId, canonical, request.requestId, request.version, 'SET_REQUIREMENTS', input.reason.trim());
    });
  }

  updateResource(
    identity: string,
    input: {
      resourceId: string;
      expectedVersion: string;
      commandId: string;
      totalCapacity?: number;
      available?: boolean;
      stepFree?: boolean;
    },
  ): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'updateResource', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const resource = this.state.resources[input.resourceId];
      if (!resource || resource.shelterId !== actor.shelterId || resource.version !== input.expectedVersion) {
        return this.rejected(identity, 'updateResource', input.commandId, canonical, 'STALE_VERSION');
      }
      if (input.totalCapacity !== undefined) {
        if (!Number.isInteger(input.totalCapacity) || input.totalCapacity < 0 || input.totalCapacity > 100) {
          throw new AuthorityError('INVALID_SCHEMA', 'Capacity must be an integer from 0 to 100.');
        }
        if (input.totalCapacity < resource.reservedUnits + resource.consumedUnits) {
          return this.rejected(identity, 'updateResource', input.commandId, canonical, 'CAPACITY_EXCEEDED');
        }
        resource.totalCapacity = input.totalCapacity;
      }
      if (input.available !== undefined) resource.available = input.available;
      if (input.stepFree !== undefined) resource.stepFree = input.stepFree;
      try {
        assertCapacityInvariant(resource);
      } catch {
        return this.rejected(identity, 'updateResource', input.commandId, canonical, 'CAPACITY_EXCEEDED');
      }
      resource.version = bumpDecimal(resource.version);
      this.bumpEpoch(actor.shelterId);
      return this.accept(identity, 'updateResource', input.commandId, canonical, resource.resourceId, resource.version, 'UPDATE_RESOURCE');
    });
  }

  createLinkedRequest(identity: string, input: { requestId: string; commandId: string; reason: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'createLinkedRequest', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const parent = this.requestInShelter(input.requestId, actor.shelterId);
      if (!parent || (parent.state !== 'COMPLETED' && parent.state !== 'CANCELLED')) {
        return this.rejected(identity, 'createLinkedRequest', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      const requestId = this.id();
      const created: RequestRow = {
        requestId,
        stationId: parent.stationId,
        shelterId: parent.shelterId,
        localSequence: `link-${requestId}`,
        needType: parent.needType,
        units: 1,
        requiresStepFree: parent.requiresStepFree,
        zoneId: parent.zoneId,
        receivedAt: this.now(),
        deviceCreatedAt: this.now(),
        state: 'NEW',
        version: '1',
        activeAssignmentId: null,
        acknowledgedBy: null,
        acknowledgedAt: null,
        linkedParentId: parent.requestId,
        canonicalSubmit: null,
      };
      this.state.requests[requestId] = created;
      this.event(created, 'CREATED', identity, input.commandId, 'LINKED_FOLLOW_UP');
      return this.accept(identity, 'createLinkedRequest', input.commandId, canonical, requestId, '1', 'LINKED_REQUEST', input.reason);
    });
  }

  startProposalRun(identity: string, input: { commandId: string; mode: RunMode }): { runId: string; snapshotId: string; omittedCount: number; receipt: ReceiptV1 } {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'startProposalRun', input.commandId, canonical);
      if (prior?.entityId) {
        const run = this.state.runs[prior.entityId];
        return {
          runId: prior.entityId,
          snapshotId: run?.snapshotId ?? '',
          omittedCount: run ? this.state.snapshots[run.snapshotId]?.omittedCount ?? 0 : 0,
          receipt: this.toReceipt(prior),
        };
      }
      if (input.mode !== 'DETERMINISTIC' && input.mode !== 'NEMOTRON') {
        throw new AuthorityError('INVALID_SCHEMA', 'Unknown proposal mode.');
      }
      const snapshot = this.captureSnapshot(actor.shelterId);
      const runId = this.id();
      this.state.runs[runId] = {
        runId,
        shelterId: actor.shelterId,
        requestedBy: identity,
        snapshotId: snapshot.snapshotId,
        mode: input.mode,
        status: 'PENDING',
        workerIdentity: null,
        leaseExpiresAt: null,
        resultPlanId: null,
        errorCode: null,
        commandId: input.commandId,
      };
      const receipt = this.accept(identity, 'startProposalRun', input.commandId, canonical, runId, '1', 'START_RUN');
      return { runId, snapshotId: snapshot.snapshotId, omittedCount: snapshot.omittedCount, receipt };
    });
  }

  claimProposalRun(identity: string, input: { runId: string; commandId: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['WORKER']);
      const prior = this.prior(identity, 'claimProposalRun', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const run = this.state.runs[input.runId];
      if (!run || run.shelterId !== actor.shelterId) return this.rejected(identity, 'claimProposalRun', input.commandId, canonical, 'NOT_FOUND');
      const now = Date.parse(this.now());
      const leaseOpen = run.leaseExpiresAt !== null && Date.parse(run.leaseExpiresAt) > now;
      if (run.status === 'RUNNING' && leaseOpen && run.workerIdentity !== identity) {
        return this.rejected(identity, 'claimProposalRun', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      if (run.status === 'COMPLETED') return this.rejected(identity, 'claimProposalRun', input.commandId, canonical, 'INVALID_TRANSITION');
      if (run.status === 'RUNNING' && !leaseOpen) run.status = 'INTERRUPTED';
      if (run.status !== 'PENDING' && run.status !== 'INTERRUPTED' && !(run.status === 'RUNNING' && run.workerIdentity === identity)) {
        return this.rejected(identity, 'claimProposalRun', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      run.status = 'RUNNING';
      run.workerIdentity = identity;
      run.leaseExpiresAt = new Date(now + LEASE_MS).toISOString();
      run.errorCode = null;
      return this.accept(identity, 'claimProposalRun', input.commandId, canonical, run.runId, '1', 'CLAIM_RUN');
    });
  }

  failProposalRun(identity: string, input: { runId: string; commandId: string; errorCode: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['WORKER']);
      const prior = this.prior(identity, 'failProposalRun', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const run = this.state.runs[input.runId];
      if (!run || run.shelterId !== actor.shelterId || run.workerIdentity !== identity || run.status !== 'RUNNING') {
        return this.rejected(identity, 'failProposalRun', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      run.status = 'FAILED';
      run.errorCode = input.errorCode.slice(0, 80);
      return this.accept(identity, 'failProposalRun', input.commandId, canonical, run.runId, '1', 'FAIL_RUN', run.errorCode);
    });
  }

  createProposedPlan(
    identity: string,
    input: {
      planId: string;
      runId: string;
      commandId: string;
      allocations: PlanAllocation[];
      unmatched: ProposedPlan['unmatched'];
      objective: ProposedPlan['objective'];
      baseline: { matchCount: number; waitingRankSum: number; travelSecondsSum: number };
      solverVersion: string;
      explanation: string;
      modelId: string | null;
    },
  ): ReceiptV1 {
    const canonical = canonicalJson({ ...input, explanation: input.explanation });
    return this.transaction(() => {
      const actor = this.actor(identity, ['WORKER']);
      const prior = this.prior(identity, 'createProposedPlan', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const run = this.state.runs[input.runId];
      if (!run || run.shelterId !== actor.shelterId || run.workerIdentity !== identity || run.status !== 'RUNNING') {
        return this.rejected(identity, 'createProposedPlan', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      const snapshot = this.state.snapshots[run.snapshotId];
      if (!snapshot) return this.rejected(identity, 'createProposedPlan', input.commandId, canonical, 'NOT_FOUND');
      if (input.solverVersion !== SOLVER_VERSION) {
        return this.rejected(identity, 'createProposedPlan', input.commandId, canonical, 'INVALID_SCHEMA');
      }
      if (input.explanation.length > EXPLANATION_MAX) {
        return this.rejected(identity, 'createProposedPlan', input.commandId, canonical, 'INVALID_SCHEMA');
      }
      const seen = new Set<string>();
      for (const allocation of input.allocations) {
        if (allocation.units !== 1 || seen.has(allocation.requestId)) {
          return this.rejected(identity, 'createProposedPlan', input.commandId, canonical, 'INVALID_SCHEMA');
        }
        seen.add(allocation.requestId);
      }
      for (const reason of input.unmatched) {
        if (!REASON_CODES.includes(reason.reason)) {
          return this.rejected(identity, 'createProposedPlan', input.commandId, canonical, 'INVALID_SCHEMA');
        }
      }
      try {
        validateAllocations(input.allocations, {
          schemaVersion: 1,
          snapshotId: snapshot.snapshotId,
          shelterId: snapshot.shelterId,
          allocationEpoch: snapshot.epoch,
          policyId: POLICY_ID,
          capturedAt: snapshot.createdAt,
          requests: snapshot.requests,
          resources: snapshot.resources,
          travelSeconds: snapshot.travelSeconds,
        });
      } catch {
        return this.rejected(identity, 'createProposedPlan', input.commandId, canonical, 'CAPACITY_EXCEEDED');
      }
      const existing = this.state.plans[input.planId];
      if (existing) {
        throw new AuthorityError('IDEMPOTENCY_CONFLICT', 'planId already exists.');
      }
      const plan: ProposedPlan = {
        planId: input.planId,
        snapshotId: snapshot.snapshotId,
        shelterId: actor.shelterId,
        proposerIdentity: identity,
        allocations: input.allocations,
        unmatched: input.unmatched,
        baselineMatchCount: input.baseline.matchCount,
        baselineWaitingRankSum: input.baseline.waitingRankSum,
        baselineTravelSeconds: input.baseline.travelSecondsSum,
        solverVersion: input.solverVersion,
        objective: input.objective,
        explanation: input.explanation,
        mode: run.mode,
        modelId: input.modelId,
        state: 'PROPOSED',
        version: '1',
        createdAt: this.now(),
      };
      this.state.plans[plan.planId] = plan;
      run.status = 'COMPLETED';
      run.resultPlanId = plan.planId;
      return this.accept(identity, 'createProposedPlan', input.commandId, canonical, plan.planId, plan.version, 'PROPOSE');
    });
  }

  createManualPlan(
    identity: string,
    input: { requestId: string; resourceId: string; expectedRequestVersion: string; commandId: string },
  ): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'createManualPlan', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const snapshot = this.captureSnapshot(actor.shelterId);
      const request = snapshot.requests.find((item) => item.requestId === input.requestId);
      const resource = snapshot.resources.find((item) => item.resourceId === input.resourceId);
      const live = this.state.requests[input.requestId];
      if (!live || live.shelterId !== actor.shelterId || live.version !== input.expectedRequestVersion) {
        return this.rejected(identity, 'createManualPlan', input.commandId, canonical, 'STALE_VERSION');
      }
      if (!request || !resource || request.version !== live.version) {
        return this.rejected(identity, 'createManualPlan', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      const travelSeconds = this.travelFor(actor.shelterId, request.zoneId, resource.zoneId);
      if (travelSeconds === undefined) {
        return this.rejected(identity, 'createManualPlan', input.commandId, canonical, 'INPUT_INCOMPLETE');
      }
      const allocation: PlanAllocation = {
        requestId: request.requestId,
        resourceId: resource.resourceId,
        units: 1,
        travelSeconds,
        waitingRank: 0,
        requestVersion: request.version,
        resourceVersion: resource.version,
      };
      try {
        validateAllocations([allocation], {
          schemaVersion: 1,
          snapshotId: snapshot.snapshotId,
          shelterId: snapshot.shelterId,
          allocationEpoch: snapshot.epoch,
          policyId: POLICY_ID,
          capturedAt: snapshot.createdAt,
          requests: snapshot.requests,
          resources: snapshot.resources,
          travelSeconds: snapshot.travelSeconds,
        });
      } catch (error) {
        const code = error instanceof SolverError ? 'CAPACITY_EXCEEDED' : 'CAPACITY_EXCEEDED';
        return this.rejected(identity, 'createManualPlan', input.commandId, canonical, code);
      }
      const planId = this.id();
      this.state.plans[planId] = {
        planId,
        snapshotId: snapshot.snapshotId,
        shelterId: actor.shelterId,
        proposerIdentity: identity,
        allocations: [allocation],
        unmatched: [],
        baselineMatchCount: 0,
        baselineWaitingRankSum: 0,
        baselineTravelSeconds: 0,
        solverVersion: 'manual-one-item-1',
        objective: { matchCount: 1, waitingRankSum: 0, travelSecondsSum: allocation.travelSeconds },
        explanation: 'Manual one-item plan. It uses the same approval reservation path as an optimized plan.',
        mode: 'MANUAL',
        modelId: null,
        state: 'PROPOSED',
        version: '1',
        createdAt: this.now(),
      };
      return this.accept(identity, 'createManualPlan', input.commandId, canonical, planId, '1', 'MANUAL_PLAN');
    });
  }

  approvePlan(identity: string, input: { planId: string; expectedPlanVersion: string; commandId: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'approvePlan', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const plan = this.state.plans[input.planId];
      if (!plan || plan.shelterId !== actor.shelterId) {
        return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'NOT_FOUND');
      }
      if (plan.version !== input.expectedPlanVersion || plan.state !== 'PROPOSED') {
        return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'STALE_PLAN');
      }
      const snapshot = this.state.snapshots[plan.snapshotId];
      if (!snapshot) return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'NOT_FOUND');
      if (Date.parse(this.now()) > Date.parse(snapshot.expiresAt)) {
        return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'EXPIRED_PLAN');
      }
      const control = this.control(actor.shelterId);
      if (control.allocationEpoch !== snapshot.epoch || control.policyVersion !== snapshot.policyVersion) {
        return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'STALE_PLAN');
      }
      const ordered = [...plan.allocations].sort((a, b) => a.requestId.localeCompare(b.requestId));
      const seen = new Set<string>();
      const demand = new Map<string, number>();
      for (const allocation of ordered) {
        if (allocation.units !== 1 || seen.has(allocation.requestId)) {
          return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'INVALID_SCHEMA');
        }
        seen.add(allocation.requestId);
        const request = this.state.requests[allocation.requestId];
        const resource = this.state.resources[allocation.resourceId];
        if (!request || !resource || request.shelterId !== actor.shelterId || resource.shelterId !== actor.shelterId) {
          return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'STALE_PLAN');
        }
        if (request.state !== 'ACKNOWLEDGED' || request.activeAssignmentId || request.version !== allocation.requestVersion) {
          return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'STALE_PLAN');
        }
        if (resource.version !== allocation.resourceVersion || !resource.available) {
          return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'STALE_PLAN');
        }
        if (request.needType !== resource.needType || !capabilityMatches(request.requiresStepFree, resource.stepFree)) {
          return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'CAPACITY_EXCEEDED');
        }
        demand.set(resource.resourceId, (demand.get(resource.resourceId) ?? 0) + 1);
      }
      for (const [resourceId, units] of demand) {
        const resource = this.state.resources[resourceId];
        if (units > freeUnits(resource)) {
          return this.rejected(identity, 'approvePlan', input.commandId, canonical, 'CAPACITY_EXCEEDED');
        }
      }
      for (const allocation of ordered) {
        const request = this.state.requests[allocation.requestId];
        const resource = this.state.resources[allocation.resourceId];
        const reserved = reserveUnits(resource, 1);
        Object.assign(resource, reserved);
        resource.version = bumpDecimal(resource.version);
        const assignmentId = this.id();
        const assignment: Assignment = {
          assignmentId,
          requestId: request.requestId,
          resourceId: resource.resourceId,
          planId: plan.planId,
          shelterId: actor.shelterId,
          units: 1,
          state: 'ACTIVE',
          volunteerIdentity: null,
          version: '1',
        };
        this.state.assignments[assignmentId] = assignment;
        this.state.reservations[assignmentId] = {
          reservationId: this.id(),
          assignmentId,
          resourceId: resource.resourceId,
          units: 1,
          state: 'HELD',
          version: '1',
        };
        request.state = 'ASSIGNED';
        request.activeAssignmentId = assignmentId;
        request.version = bumpDecimal(request.version);
        this.event(request, 'ASSIGNED', identity, input.commandId);
      }
      plan.state = 'APPROVED';
      plan.version = bumpDecimal(plan.version);
      const epoch = control.allocationEpoch;
      this.bumpEpoch(actor.shelterId);
      this.state.approvals.push({
        approvalId: this.id(),
        planId: plan.planId,
        actorIdentity: identity,
        serverTime: this.now(),
        commandId: input.commandId,
        epoch,
        result: 'APPROVED',
      });
      return this.accept(identity, 'approvePlan', input.commandId, canonical, plan.planId, plan.version, 'APPROVE');
    });
  }

  rejectPlan(identity: string, input: { planId: string; expectedPlanVersion: string; commandId: string; reason: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'rejectPlan', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const plan = this.state.plans[input.planId];
      if (!plan || plan.shelterId !== actor.shelterId || plan.version !== input.expectedPlanVersion || plan.state !== 'PROPOSED') {
        return this.rejected(identity, 'rejectPlan', input.commandId, canonical, 'STALE_PLAN');
      }
      plan.state = 'REJECTED';
      plan.version = bumpDecimal(plan.version);
      return this.accept(identity, 'rejectPlan', input.commandId, canonical, plan.planId, plan.version, 'REJECT', input.reason?.slice(0, 200) ?? null);
    });
  }

  attachVolunteer(identity: string, input: { assignmentId: string; volunteerIdentity: string; expectedAssignmentVersion: string; commandId: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['COORDINATOR']);
      const prior = this.prior(identity, 'attachVolunteer', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const assignment = this.state.assignments[input.assignmentId];
      const volunteer = this.state.volunteers[input.volunteerIdentity];
      const principal = this.state.principals[input.volunteerIdentity];
      if (!assignment || assignment.shelterId !== actor.shelterId || assignment.version !== input.expectedAssignmentVersion || assignment.state !== 'ACTIVE') {
        return this.rejected(identity, 'attachVolunteer', input.commandId, canonical, 'STALE_VERSION');
      }
      if (!volunteer || !principal || !principal.enabled || principal.role !== 'VOLUNTEER' || volunteer.shelterId !== actor.shelterId || !volunteer.available || volunteer.activeAssignmentId) {
        return this.rejected(identity, 'attachVolunteer', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      assignment.volunteerIdentity = volunteer.principalIdentity;
      assignment.version = bumpDecimal(assignment.version);
      volunteer.activeAssignmentId = assignment.assignmentId;
      volunteer.version = bumpDecimal(volunteer.version);
      return this.accept(identity, 'attachVolunteer', input.commandId, canonical, assignment.assignmentId, assignment.version, 'ATTACH_VOLUNTEER');
    });
  }

  completeAssignment(
    identity: string,
    input: { assignmentId: string; expectedAssignmentVersion: string; expectedRequestVersion: string; commandId: string },
  ): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const principal = this.actor(identity, ['COORDINATOR', 'VOLUNTEER']);
      const prior = this.prior(identity, 'completeAssignment', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const assignment = this.state.assignments[input.assignmentId];
      if (!assignment || assignment.shelterId !== principal.shelterId) {
        return this.rejected(identity, 'completeAssignment', input.commandId, canonical, 'NOT_FOUND');
      }
      if (principal.role === 'VOLUNTEER' && assignment.volunteerIdentity !== identity) {
        throw new AuthorityError('FORBIDDEN', 'Not allowed.');
      }
      const request = this.state.requests[assignment.requestId];
      if (!request || assignment.version !== input.expectedAssignmentVersion || request.version !== input.expectedRequestVersion) {
        return this.rejected(identity, 'completeAssignment', input.commandId, canonical, 'STALE_VERSION');
      }
      if (request.state !== 'ASSIGNED' || assignment.state !== 'ACTIVE') {
        return this.rejected(identity, 'completeAssignment', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      const resource = this.state.resources[assignment.resourceId];
      const reservation = Object.values(this.state.reservations).find((item) => item.assignmentId === assignment.assignmentId);
      if (!resource || !reservation || reservation.state !== 'HELD') {
        return this.rejected(identity, 'completeAssignment', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      Object.assign(resource, completeUnits(resource, 1));
      resource.version = bumpDecimal(resource.version);
      reservation.state = resource.accountingMode === 'CONSUMABLE' ? 'CONSUMED' : 'RELEASED';
      reservation.version = bumpDecimal(reservation.version);
      assignment.state = 'COMPLETED';
      assignment.version = bumpDecimal(assignment.version);
      request.state = 'COMPLETED';
      request.activeAssignmentId = null;
      request.version = bumpDecimal(request.version);
      this.releaseVolunteer(assignment.assignmentId);
      this.bumpEpoch(principal.shelterId);
      this.event(request, 'COMPLETED', identity, input.commandId);
      return this.accept(identity, 'completeAssignment', input.commandId, canonical, request.requestId, request.version, 'COMPLETE');
    });
  }

  registerPrincipal(identity: string, input: { principalIdentity: string; role: Role; commandId: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['ADMIN']);
      const prior = this.prior(identity, 'registerPrincipal', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      if (!['ADMIN', 'COORDINATOR', 'VOLUNTEER', 'STATION', 'WORKER'].includes(input.role)) {
        throw new AuthorityError('INVALID_SCHEMA', 'Unknown role.');
      }
      this.state.principals[input.principalIdentity] = {
        identity: input.principalIdentity,
        role: input.role,
        shelterId: actor.shelterId,
        enabled: true,
        version: '1',
      };
      if (input.role === 'VOLUNTEER' && !this.state.volunteers[input.principalIdentity]) {
        this.state.volunteers[input.principalIdentity] = {
          principalIdentity: input.principalIdentity,
          shelterId: actor.shelterId,
          displayLabel: 'Volunteer',
          available: true,
          activeAssignmentId: null,
          version: '1',
        };
      }
      return this.accept(identity, 'registerPrincipal', input.commandId, canonical, input.principalIdentity, '1', 'REGISTER');
    });
  }

  registerStation(
    identity: string,
    input: {
      commandId: string;
      stationId: string;
      principalIdentity: string;
      installationId: string;
      label: string;
      zoneId: string;
      allowedCategories: NeedType[];
    },
  ): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['ADMIN']);
      const prior = this.prior(identity, 'registerStation', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const principal = this.state.principals[input.principalIdentity];
      if (!principal || principal.role !== 'STATION' || principal.shelterId !== actor.shelterId) {
        return this.rejected(identity, 'registerStation', input.commandId, canonical, 'INVALID_TRANSITION');
      }
      if (this.state.stations[input.stationId]) throw new AuthorityError('IDEMPOTENCY_CONFLICT', 'stationId already exists.');
      this.state.stations[input.stationId] = {
        stationId: input.stationId,
        principalIdentity: input.principalIdentity,
        installationId: input.installationId,
        shelterId: actor.shelterId,
        label: input.label.slice(0, 80),
        zoneId: input.zoneId.slice(0, 32),
        allowedCategories: input.allowedCategories.filter((need) => need === 'WATER' || need === 'CHARGING'),
        enabled: true,
        version: '1',
      };
      return this.accept(identity, 'registerStation', input.commandId, canonical, input.stationId, '1', 'REGISTER_STATION');
    });
  }

  revokePrincipal(identity: string, input: { principalIdentity: string; commandId: string }): ReceiptV1 {
    const canonical = canonicalJson(input);
    return this.transaction(() => {
      const actor = this.actor(identity, ['ADMIN']);
      const prior = this.prior(identity, 'revokePrincipal', input.commandId, canonical);
      if (prior) return this.toReceipt(prior);
      const target = this.state.principals[input.principalIdentity];
      if (!target || target.shelterId !== actor.shelterId) return this.rejected(identity, 'revokePrincipal', input.commandId, canonical, 'NOT_FOUND');
      target.enabled = false;
      target.version = bumpDecimal(target.version);
      return this.accept(identity, 'revokePrincipal', input.commandId, canonical, target.identity, target.version, 'REVOKE');
    });
  }

  resetDemo(identity: string, input: { commandId: string; confirm: string }): ReceiptV1 {
    return this.transaction(() => {
      this.actor(identity, ['ADMIN']);
      if (input.confirm !== 'RESET DEMO SHELTER') throw new AuthorityError('FORBIDDEN', 'Not allowed.');
      this.state = buildDemoState();
      return {
        commandId: input.commandId,
        outcome: 'ACCEPTED' as const,
        commandType: 'resetDemo',
      };
    });
  }

  private accept(
    identity: string,
    commandType: string,
    commandId: string,
    canonical: string,
    entityId: string,
    entityVersion: string,
    action: string,
    reason: string | null = null,
  ): ReceiptV1 {
    const principal = this.state.principals[identity];
    const row = this.receipt({
      callerIdentity: identity,
      commandId,
      commandType,
      canonicalInput: canonical,
      outcome: 'ACCEPTED',
      entityId,
      entityVersion,
      errorCode: null,
    });
    this.audit({
      shelterId: principal?.shelterId ?? DEMO_IDS.shelterId,
      action,
      actorIdentity: identity,
      targetId: entityId,
      reason,
      commandId,
    });
    return this.toReceipt(row);
  }

  private requestInShelter(requestId: string, shelterId: string): RequestRow | null {
    const request = this.state.requests[requestId];
    if (!request || request.shelterId !== shelterId) return null;
    return request;
  }

  private releaseActiveAssignment(request: RequestRow, shelterId: string): void {
    if (!request.activeAssignmentId) return;
    const assignment = this.state.assignments[request.activeAssignmentId];
    if (!assignment || assignment.state !== 'ACTIVE') return;
    const reservation = Object.values(this.state.reservations).find((item) => item.assignmentId === assignment.assignmentId);
    const resource = this.state.resources[assignment.resourceId];
    if (reservation?.state === 'HELD' && resource) {
      Object.assign(resource, releaseUnits(resource, reservation.units));
      resource.version = bumpDecimal(resource.version);
      reservation.state = 'RELEASED';
      reservation.version = bumpDecimal(reservation.version);
    }
    assignment.state = 'CANCELLED';
    assignment.version = bumpDecimal(assignment.version);
    this.releaseVolunteer(assignment.assignmentId);
    void shelterId;
  }

  private releaseVolunteer(assignmentId: string): void {
    for (const volunteer of Object.values(this.state.volunteers)) {
      if (volunteer.activeAssignmentId === assignmentId) {
        volunteer.activeAssignmentId = null;
        volunteer.version = bumpDecimal(volunteer.version);
      }
    }
  }

  private travelFor(shelterId: string, from: string, to: string): number | undefined {
    return this.state.travelSeconds.find((hop) => hop.shelterId === shelterId && hop.from === from && hop.to === to)?.seconds;
  }

  captureSnapshot(shelterId: string): AllocationSnapshot {
    const control = this.control(shelterId);
    const resources = Object.values(this.state.resources)
      .filter((resource) => resource.shelterId === shelterId)
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    if (resources.length > MAX_RESOURCE_POOLS) throw new AuthorityError('BATCH_LIMIT', 'Too many resource pools for one plan.');
    const free = resources.reduce((sum, resource) => sum + Math.max(0, freeUnits(resource)), 0);
    if (free > MAX_FREE_UNITS) throw new AuthorityError('BATCH_LIMIT', 'Too many free units for one plan.');
    const eligible = Object.values(this.state.requests)
      .filter((request) => request.shelterId === shelterId && request.state === 'ACKNOWLEDGED' && !request.activeAssignmentId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.requestId.localeCompare(b.requestId));
    const omittedCount = Math.max(0, eligible.length - MAX_REQUESTS);
    const selected = eligible.slice(0, MAX_REQUESTS);
    const zones = new Set<string>([...selected.map((request) => request.zoneId), ...resources.map((resource) => resource.zoneId)]);
    const travelSeconds = this.state.travelSeconds
      .filter((hop) => hop.shelterId === shelterId && zones.has(hop.from) && zones.has(hop.to))
      .map(({ from, to, seconds }) => ({ from, to, seconds }));
    const snapshot: AllocationSnapshot = {
      snapshotId: this.id(),
      shelterId,
      epoch: control.allocationEpoch,
      policyVersion: control.policyVersion,
      policyId: POLICY_ID,
      createdAt: this.now(),
      expiresAt: new Date(Date.parse(this.now()) + SNAPSHOT_TTL_MS).toISOString(),
      omittedCount,
      canonicalHash: '',
      requests: selected.map((request) => ({
        requestId: request.requestId,
        version: request.version,
        state: request.state,
        needType: request.needType,
        units: 1 as const,
        receivedAt: request.receivedAt,
        zoneId: request.zoneId,
        requiresStepFree: request.requiresStepFree,
        stationId: request.stationId,
      })),
      resources: structuredClone(resources),
      travelSeconds,
    };
    snapshot.canonicalHash = sha256(canonicalJson({ requests: snapshot.requests, resources: snapshot.resources, travelSeconds, epoch: snapshot.epoch }));
    this.state.snapshots[snapshot.snapshotId] = snapshot;
    return snapshot;
  }

  /** Used by the worker after it has claimed a run. Read-only. */
  readSnapshot(identity: string, snapshotId: string): AllocationSnapshot | null {
    const actor = this.actor(identity, ['WORKER', 'COORDINATOR']);
    const snapshot = this.state.snapshots[snapshotId];
    if (!snapshot || snapshot.shelterId !== actor.shelterId) return null;
    return structuredClone(snapshot);
  }

  pendingRuns(identity: string) {
    const actor = this.actor(identity, ['WORKER']);
    return Object.values(this.state.runs).filter((run) => run.shelterId === actor.shelterId && (run.status === 'PENDING' || run.status === 'INTERRUPTED'));
  }

  myStationRequests(identity: string) {
    const station = this.stationFor(identity);
    const requests = Object.values(this.state.requests)
      .filter((request) => request.stationId === station.stationId)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map((request) => this.publicRequest(request));
    return { station: { stationId: station.stationId, label: station.label, zoneId: station.zoneId }, requests, serverTime: this.now() };
  }

  myReceipts(identity: string) {
    this.actor(identity);
    return Object.values(this.state.receipts)
      .filter((receipt) => receipt.callerIdentity === identity)
      .map((receipt) => this.toReceipt(receipt));
  }

  coordinatorRequests(identity: string) {
    const actor = this.actor(identity, ['COORDINATOR', 'ADMIN']);
    const latestPlan = this.latestPlan(actor.shelterId);
    const unmatched = new Map((latestPlan?.unmatched ?? []).map((item) => [item.requestId, item]));
    const requests = Object.values(this.state.requests)
      .filter((request) => request.shelterId === actor.shelterId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      .map((request) => ({
        ...this.publicRequest(request),
        stationLabel: this.state.stations[request.stationId]?.label ?? request.stationId,
        linkedParentId: request.linkedParentId,
        unmatchedReason: unmatched.get(request.requestId)?.reason ?? null,
        unmatchedDetail: unmatched.get(request.requestId)?.detail ?? null,
        events: this.state.events
          .filter((event) => event.requestId === request.requestId)
          .map((event) => ({
            kind: event.kind,
            version: event.version,
            serverTime: event.serverTime,
            reasonCode: event.reasonCode,
          })),
      }));
    const counts = {
      NEW: requests.filter((request) => request.state === 'NEW').length,
      ACKNOWLEDGED: requests.filter((request) => request.state === 'ACKNOWLEDGED').length,
      UNMATCHED: requests.filter((request) => request.state === 'ACKNOWLEDGED' && request.unmatchedReason).length,
      ASSIGNED: requests.filter((request) => request.state === 'ASSIGNED').length,
      COMPLETED: requests.filter((request) => request.state === 'COMPLETED').length,
      CANCELLED: requests.filter((request) => request.state === 'CANCELLED').length,
    };
    return {
      shelterName: this.state.shelterName,
      allocationEpoch: this.control(actor.shelterId).allocationEpoch,
      serverTime: this.now(),
      counts,
      requests,
    };
  }

  coordinatorResources(identity: string) {
    const actor = this.actor(identity, ['COORDINATOR', 'ADMIN']);
    return {
      serverTime: this.now(),
      allocationEpoch: this.control(actor.shelterId).allocationEpoch,
      resources: Object.values(this.state.resources)
        .filter((resource) => resource.shelterId === actor.shelterId)
        .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
        .map((resource) => ({
          ...resource,
          freeUnits: freeUnits(resource),
        })),
      travelSeconds: this.state.travelSeconds.filter((hop) => hop.shelterId === actor.shelterId),
    };
  }

  coordinatorPlans(identity: string) {
    const actor = this.actor(identity, ['COORDINATOR', 'ADMIN']);
    const control = this.control(actor.shelterId);
    const plans = Object.values(this.state.plans)
      .filter((plan) => plan.shelterId === actor.shelterId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((plan) => {
        const snapshot = this.state.snapshots[plan.snapshotId];
        const expired = snapshot ? Date.parse(this.now()) > Date.parse(snapshot.expiresAt) : true;
        const epochMismatch = snapshot ? snapshot.epoch !== control.allocationEpoch || snapshot.policyVersion !== control.policyVersion : true;
        return {
          ...plan,
          snapshotCreatedAt: snapshot?.createdAt ?? null,
          snapshotExpiresAt: snapshot?.expiresAt ?? null,
          snapshotEpoch: snapshot?.epoch ?? null,
          omittedCount: snapshot?.omittedCount ?? 0,
          currentEpoch: control.allocationEpoch,
          stale: expired || epochMismatch,
          expired,
          epochMismatch,
        };
      });
    return { serverTime: this.now(), plans };
  }

  coordinatorActivity(identity: string) {
    const actor = this.actor(identity, ['COORDINATOR', 'ADMIN']);
    return {
      serverTime: this.now(),
      audits: this.state.audits
        .filter((audit) => audit.shelterId === actor.shelterId)
        .slice(-80)
        .reverse()
        .map((audit) => ({
          action: audit.action,
          targetId: audit.targetId,
          reason: audit.reason,
          serverTime: audit.serverTime,
          actorRole: this.state.principals[audit.actorIdentity]?.role ?? 'UNKNOWN',
        })),
    };
  }

  myVolunteerAssignments(identity: string) {
    const actor = this.actor(identity, ['VOLUNTEER']);
    const volunteer = this.state.volunteers[identity];
    const assignments = Object.values(this.state.assignments)
      .filter((assignment) => assignment.volunteerIdentity === identity && assignment.shelterId === actor.shelterId)
      .map((assignment) => {
        const request = this.state.requests[assignment.requestId];
        const resource = this.state.resources[assignment.resourceId];
        return {
          assignmentId: assignment.assignmentId,
          assignmentVersion: assignment.version,
          state: assignment.state,
          requestId: assignment.requestId,
          requestVersion: request?.version ?? null,
          requestState: request?.state ?? null,
          needType: request?.needType ?? null,
          zoneId: request?.zoneId ?? null,
          resourceId: assignment.resourceId,
          resourceLabel: resource?.label ?? assignment.resourceId,
        };
      });
    return {
      displayLabel: volunteer?.displayLabel ?? 'Volunteer',
      serverTime: this.now(),
      assignments,
    };
  }

  workerSnapshots(identity: string) {
    const actor = this.actor(identity, ['WORKER']);
    const runs = Object.values(this.state.runs).filter((run) => run.shelterId === actor.shelterId);
    return {
      serverTime: this.now(),
      runs: runs.map((run) => ({
        runId: run.runId,
        snapshotId: run.snapshotId,
        mode: run.mode,
        status: run.status,
        leaseExpiresAt: run.leaseExpiresAt,
        resultPlanId: run.resultPlanId,
        errorCode: run.errorCode,
      })),
    };
  }

  private latestPlan(shelterId: string): ProposedPlan | null {
    return Object.values(this.state.plans)
      .filter((plan) => plan.shelterId === shelterId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  private publicRequest(request: RequestRow) {
    const assignment = request.activeAssignmentId
      ? this.state.assignments[request.activeAssignmentId]
      : Object.values(this.state.assignments)
          .filter((item) => item.requestId === request.requestId)
          .sort((a, b) => b.version.localeCompare(a.version))[0] ?? null;
    const resource = assignment ? this.state.resources[assignment.resourceId] : null;
    return {
      requestId: request.requestId,
      needType: request.needType,
      units: request.units as 1,
      state: request.state,
      version: request.version,
      receivedAt: request.receivedAt,
      deviceCreatedAt: request.deviceCreatedAt,
      zoneId: request.zoneId,
      requiresStepFree: request.requiresStepFree,
      stationId: request.stationId,
      assignmentId: assignment?.assignmentId ?? null,
      assignmentVersion: assignment?.version ?? null,
      assignmentState: assignment?.state ?? null,
      resourceId: resource?.resourceId ?? null,
      resourceLabel: resource?.label ?? null,
    };
  }
}

export function solveSnapshot(snapshot: AllocationSnapshot) {
  return solve({
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
  });
}

export type { NeedType };
