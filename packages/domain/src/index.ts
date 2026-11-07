import type {
  AccountingMode,
  NeedType,
  RequestState,
  SnapshotRequest,
  SnapshotResource,
} from '@relayaid/contracts';

export type CapacityResource = {
  totalCapacity: number;
  reservedUnits: number;
  consumedUnits: number;
  accountingMode: AccountingMode;
  available: boolean;
};

export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function freeUnits(resource: Pick<CapacityResource, 'totalCapacity' | 'reservedUnits' | 'consumedUnits'>): number {
  return resource.totalCapacity - resource.reservedUnits - resource.consumedUnits;
}

export function assertCapacityInvariant(resource: CapacityResource): void {
  const { totalCapacity, reservedUnits, consumedUnits, accountingMode } = resource;
  if (!Number.isInteger(totalCapacity) || totalCapacity < 0) {
    throw new DomainError('CAPACITY_EXCEEDED', 'totalCapacity must be a nonnegative integer.');
  }
  if (!Number.isInteger(reservedUnits) || reservedUnits < 0) {
    throw new DomainError('CAPACITY_EXCEEDED', 'reservedUnits must be a nonnegative integer.');
  }
  if (!Number.isInteger(consumedUnits) || consumedUnits < 0) {
    throw new DomainError('CAPACITY_EXCEEDED', 'consumedUnits must be a nonnegative integer.');
  }
  if (reservedUnits + consumedUnits > totalCapacity) {
    throw new DomainError('CAPACITY_EXCEEDED', 'reserved plus consumed exceeds total capacity.');
  }
  if (accountingMode === 'REUSABLE' && consumedUnits !== 0) {
    throw new DomainError('CAPACITY_EXCEEDED', 'Reusable charging capacity cannot be consumed.');
  }
}

export function categoryMatches(needType: NeedType, resourceNeed: NeedType): boolean {
  return needType === resourceNeed;
}

/** Absent or unknown step-free confirmation is not a positive match. */
export function capabilityMatches(requiresStepFree: boolean, stepFree: boolean): boolean {
  if (requiresStepFree) return stepFree === true;
  return true;
}

export function isAssignableEdge(
  request: Pick<SnapshotRequest, 'needType' | 'requiresStepFree' | 'units'>,
  resource: SnapshotResource,
): boolean {
  if (!categoryMatches(request.needType, resource.needType)) return false;
  if (!resource.available) return false;
  if (!capabilityMatches(request.requiresStepFree, resource.stepFree)) return false;
  if (freeUnits(resource) < request.units) return false;
  return true;
}

export function reserveUnits<T extends CapacityResource>(resource: T, units: number): T {
  const next = { ...resource, reservedUnits: resource.reservedUnits + units };
  assertCapacityInvariant(next);
  return next;
}

export function completeUnits<T extends CapacityResource>(resource: T, units: number): T {
  if (resource.reservedUnits < units) {
    throw new DomainError('INVALID_TRANSITION', 'Cannot settle more units than are reserved.');
  }
  const next: T =
    resource.accountingMode === 'CONSUMABLE'
      ? { ...resource, reservedUnits: resource.reservedUnits - units, consumedUnits: resource.consumedUnits + units }
      : { ...resource, reservedUnits: resource.reservedUnits - units };
  assertCapacityInvariant(next);
  return next;
}

export function releaseUnits<T extends CapacityResource>(resource: T, units: number): T {
  if (resource.reservedUnits < units) {
    throw new DomainError('INVALID_TRANSITION', 'Cannot release more units than are reserved.');
  }
  const next = { ...resource, reservedUnits: resource.reservedUnits - units };
  assertCapacityInvariant(next);
  return next;
}

const TRANSITIONS: Record<RequestState, RequestState[]> = {
  NEW: ['ACKNOWLEDGED', 'CANCELLED'],
  ACKNOWLEDGED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: RequestState, to: RequestState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RequestState, to: RequestState): void {
  if (!canTransition(from, to)) {
    throw new DomainError('INVALID_TRANSITION', `${from} cannot move to ${to}.`);
  }
}

export function isTerminal(state: RequestState): boolean {
  return state === 'COMPLETED' || state === 'CANCELLED';
}

export function accountingModeFor(needType: NeedType): AccountingMode {
  return needType === 'WATER' ? 'CONSUMABLE' : 'REUSABLE';
}
