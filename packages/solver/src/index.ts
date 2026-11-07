import {
  MAX_FREE_UNITS,
  MAX_REQUESTS,
  MAX_RESOURCE_POOLS,
  MAX_TRAVEL_SECONDS,
  POLICY_ID,
  SOLVER_VERSION,
  type Allocation,
  type AllocationSnapshotInput,
  type ObjectiveTotals,
  type ReasonCode,
  type SnapshotRequest,
  type SnapshotResource,
  type UnmatchedReason,
} from '@relayaid/contracts';
import { capabilityMatches, categoryMatches, freeUnits } from '@relayaid/domain';

export class SolverError extends Error {
  readonly code: 'INPUT_INCOMPLETE' | 'BATCH_LIMIT' | 'INVALID_SCHEMA';
  readonly missingPairs: { requestId: string; resourceId: string }[];
  constructor(
    code: 'INPUT_INCOMPLETE' | 'BATCH_LIMIT' | 'INVALID_SCHEMA',
    message: string,
    missingPairs: { requestId: string; resourceId: string }[] = [],
  ) {
    super(message);
    this.name = 'SolverError';
    this.code = code;
    this.missingPairs = missingPairs;
  }
}

export type SolverSuccess = {
  ok: true;
  allocations: Allocation[];
  unmatched: UnmatchedReason[];
  excluded: UnmatchedReason[];
  objective: ObjectiveTotals;
  baseline: {
    allocations: Allocation[];
    unmatched: UnmatchedReason[];
    objective: ObjectiveTotals;
  };
  solverVersion: typeof SOLVER_VERSION;
  policyId: typeof POLICY_ID;
};

type Edge = { to: number; rev: number; cap: number; cost: number; kind?: 'assign'; requestId?: string; resourceId?: string };

function assertSnapshotShape(snapshot: AllocationSnapshotInput): void {
  if (snapshot.schemaVersion !== 1) throw new SolverError('INVALID_SCHEMA', 'Unsupported snapshot schema.');
  if (snapshot.policyId !== POLICY_ID) throw new SolverError('INVALID_SCHEMA', 'Unsupported policy.');
  if (snapshot.requests.length > MAX_REQUESTS) throw new SolverError('BATCH_LIMIT', 'Request batch exceeds 100.');
  if (snapshot.resources.length > MAX_RESOURCE_POOLS) throw new SolverError('BATCH_LIMIT', 'Resource pools exceed 30.');
  let free = 0;
  for (const resource of snapshot.resources) {
    if (!Number.isInteger(resource.totalCapacity) || resource.totalCapacity < 0) {
      throw new SolverError('INVALID_SCHEMA', 'Capacity must be a nonnegative integer.');
    }
    const units = freeUnits(resource);
    if (units < 0 || resource.reservedUnits < 0 || resource.consumedUnits < 0) {
      throw new SolverError('INVALID_SCHEMA', 'Resource counters are inconsistent.');
    }
    if (resource.accountingMode === 'REUSABLE' && resource.consumedUnits !== 0) {
      throw new SolverError('INVALID_SCHEMA', 'Reusable resources cannot already be consumed.');
    }
    free += Math.max(0, units);
  }
  if (free > MAX_FREE_UNITS) throw new SolverError('BATCH_LIMIT', 'Free units exceed 100.');
  for (const hop of snapshot.travelSeconds) {
    if (!Number.isInteger(hop.seconds) || hop.seconds < 0 || hop.seconds > MAX_TRAVEL_SECONDS) {
      throw new SolverError('INVALID_SCHEMA', 'Travel seconds must be an integer from 0 to 3600.');
    }
  }
}

function waitingOrder(requests: SnapshotRequest[]): SnapshotRequest[] {
  return [...requests].sort((a, b) => {
    const time = a.receivedAt.localeCompare(b.receivedAt);
    if (time !== 0) return time;
    return a.requestId.localeCompare(b.requestId);
  });
}

function travelLookup(snapshot: AllocationSnapshotInput): Map<string, number> {
  const map = new Map<string, number>();
  for (const hop of snapshot.travelSeconds) map.set(`${hop.from}\0${hop.to}`, hop.seconds);
  return map;
}

function suitableResources(request: SnapshotRequest, resources: SnapshotResource[]): SnapshotResource[] {
  return resources.filter(
    (resource) => categoryMatches(request.needType, resource.needType) && capabilityMatches(request.requiresStepFree, resource.stepFree),
  );
}

export function explainUnmatched(
  request: SnapshotRequest,
  resources: SnapshotResource[],
  allocations: Allocation[],
): UnmatchedReason {
  const category = resources.filter((resource) => categoryMatches(request.needType, resource.needType));
  if (category.length === 0) {
    return {
      requestId: request.requestId,
      reason: 'NO_CATEGORY_RESOURCE',
      evidenceIds: [],
      detail: `No ${request.needType.toLowerCase()} resource is in this snapshot.`,
    };
  }
  const capable = suitableResources(request, resources);
  if (capable.length === 0) {
    const evidenceIds = category.map((resource) => resource.resourceId).sort();
    const notes = category
      .map((resource) => `${resource.resourceId} is ${resource.stepFree ? 'step-free' : 'not confirmed step-free'}`)
      .join('; ');
    return {
      requestId: request.requestId,
      reason: 'CAPABILITY_UNAVAILABLE',
      evidenceIds,
      detail: `${notes}.`,
    };
  }
  const available = capable.filter((resource) => resource.available);
  if (available.length === 0) {
    return {
      requestId: request.requestId,
      reason: 'RESOURCE_UNAVAILABLE',
      evidenceIds: capable.map((resource) => resource.resourceId).sort(),
      detail: `${capable.map((resource) => resource.resourceId).sort().join(', ')} can serve this need but ${capable.length === 1 ? 'is' : 'are'} marked unavailable.`,
    };
  }
  const withStock = available.filter((resource) => freeUnits(resource) > 0);
  if (withStock.length === 0) {
    return {
      requestId: request.requestId,
      reason: 'CAPACITY_EXHAUSTED',
      evidenceIds: available.map((resource) => resource.resourceId).sort(),
      detail: available
        .map((resource) => `${resource.resourceId} has ${freeUnits(resource)} free units`)
        .sort()
        .join('; ') + '.',
    };
  }
  const used = allocations.filter((allocation) => withStock.some((resource) => resource.resourceId === allocation.resourceId));
  const evidenceIds = [...new Set([...withStock.map((resource) => resource.resourceId), ...used.map((allocation) => allocation.requestId)])].sort();
  const taken = used.map((allocation) => `${allocation.resourceId} assigned to ${allocation.requestId}`).join('; ');
  return {
    requestId: request.requestId,
    reason: 'CAPACITY_COMPETITION',
    evidenceIds,
    detail: taken
      ? `Suitable free units existed. ${taken}.`
      : `Suitable free units existed and were allocated under ${POLICY_ID}.`,
  };
}

function objectiveOf(allocations: Allocation[]): ObjectiveTotals {
  return {
    matchCount: allocations.length,
    waitingRankSum: allocations.reduce((sum, allocation) => sum + allocation.waitingRank, 0),
    travelSecondsSum: allocations.reduce((sum, allocation) => sum + allocation.travelSeconds, 0),
  };
}

class Heap {
  private data: Array<[number, string, number]> = [];
  get size(): number {
    return this.data.length;
  }
  push(item: [number, string, number]): void {
    this.data.push(item);
    this.bubble(this.data.length - 1);
  }
  pop(): [number, string, number] | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length && last) {
      this.data[0] = last;
      this.sink(0);
    }
    return top;
  }
  private less(i: number, j: number): boolean {
    const a = this.data[i];
    const b = this.data[j];
    if (a[0] !== b[0]) return a[0] < b[0];
    if (a[1] !== b[1]) return a[1] < b[1];
    return a[2] < b[2];
  }
  private bubble(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (!this.less(i, parent)) break;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }
  private sink(index: number): void {
    let i = index;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let best = i;
      if (left < this.data.length && this.less(left, best)) best = left;
      if (right < this.data.length && this.less(right, best)) best = right;
      if (best === i) break;
      [this.data[i], this.data[best]] = [this.data[best], this.data[i]];
      i = best;
    }
  }
}

function pad(index: number): string {
  return index.toString(36).padStart(4, '0');
}

function minCostMaxFlow(graph: Edge[][], source: number, sink: number): void {
  const potential = Array(graph.length).fill(0);
  for (;;) {
    const dist = Array(graph.length).fill(Number.POSITIVE_INFINITY);
    const pathKey = Array(graph.length).fill('');
    const parentNode = Array(graph.length).fill(-1);
    const parentEdge = Array(graph.length).fill(-1);
    dist[source] = 0;
    pathKey[source] = pad(source);
    const heap = new Heap();
    heap.push([0, pathKey[source], source]);
    while (heap.size) {
      const next = heap.pop();
      if (!next) break;
      const [d, key, node] = next;
      if (d !== dist[node] || key !== pathKey[node]) continue;
      for (let index = 0; index < graph[node].length; index += 1) {
        const edge = graph[node][index];
        if (edge.cap <= 0) continue;
        const reduced = edge.cost + potential[node] - potential[edge.to];
        const nd = d + reduced;
        const nk = `${key}/${pad(edge.to)}`;
        if (nd < dist[edge.to] || (nd === dist[edge.to] && nk < pathKey[edge.to])) {
          dist[edge.to] = nd;
          pathKey[edge.to] = nk;
          parentNode[edge.to] = node;
          parentEdge[edge.to] = index;
          heap.push([nd, nk, edge.to]);
        }
      }
    }
    if (!Number.isFinite(dist[sink])) break;
    for (let node = 0; node < graph.length; node += 1) {
      if (Number.isFinite(dist[node])) potential[node] += dist[node];
    }
    let flow = Number.POSITIVE_INFINITY;
    for (let node = sink; node !== source; node = parentNode[node]) {
      flow = Math.min(flow, graph[parentNode[node]][parentEdge[node]].cap);
    }
    for (let node = sink; node !== source; node = parentNode[node]) {
      const edge = graph[parentNode[node]][parentEdge[node]];
      edge.cap -= flow;
      graph[node][edge.rev].cap += flow;
    }
  }
}

function addEdge(graph: Edge[][], from: number, to: number, cap: number, cost: number, extra?: Partial<Edge>): void {
  const forward: Edge = { to, rev: graph[to].length, cap, cost, ...extra };
  const backward: Edge = { to: from, rev: graph[from].length, cap: 0, cost: -cost };
  graph[from].push(forward);
  graph[to].push(backward);
}

function solveFlow(
  eligible: SnapshotRequest[],
  resources: SnapshotResource[],
  travel: Map<string, number>,
): { allocations: Allocation[]; ranks: Map<string, number> } {
  const ranked = waitingOrder(eligible);
  const ranks = new Map(ranked.map((request, index) => [request.requestId, index]));
  const n = ranked.length;
  const w = n * MAX_TRAVEL_SECONDS + 1;
  const resourceOrder = [...resources].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
  const requestIndex = new Map(ranked.map((request, index) => [request.requestId, index + 1]));
  const resourceIndex = new Map(resourceOrder.map((resource, index) => [resource.resourceId, n + 1 + index]));
  const sink = n + resourceOrder.length + 1;
  const graph: Edge[][] = Array.from({ length: sink + 1 }, () => []);

  for (const request of ranked) {
    addEdge(graph, 0, requestIndex.get(request.requestId)!, 1, 0);
  }
  const missing: { requestId: string; resourceId: string }[] = [];
  for (const request of ranked) {
    const compatible = resourceOrder.filter((resource) => {
      if (!categoryMatches(request.needType, resource.needType)) return false;
      if (!resource.available) return false;
      if (!capabilityMatches(request.requiresStepFree, resource.stepFree)) return false;
      return freeUnits(resource) > 0;
    });
    for (const resource of compatible) {
      const seconds = travel.get(`${request.zoneId}\0${resource.zoneId}`);
      if (seconds === undefined) missing.push({ requestId: request.requestId, resourceId: resource.resourceId });
    }
  }
  if (missing.length > 0) {
    missing.sort((a, b) => a.requestId.localeCompare(b.requestId) || a.resourceId.localeCompare(b.resourceId));
    throw new SolverError('INPUT_INCOMPLETE', `Missing travel estimate for ${missing[0].requestId} → ${missing[0].resourceId}.`, missing);
  }
  for (const request of ranked) {
    const compatible = resourceOrder.filter(
      (resource) =>
        categoryMatches(request.needType, resource.needType) &&
        resource.available &&
        capabilityMatches(request.requiresStepFree, resource.stepFree) &&
        freeUnits(resource) > 0,
    );
    for (const resource of compatible) {
      const seconds = travel.get(`${request.zoneId}\0${resource.zoneId}`)!;
      const rank = ranks.get(request.requestId)!;
      const cost = rank * w + seconds;
      if (!Number.isSafeInteger(cost)) throw new SolverError('INVALID_SCHEMA', 'Objective cost exceeded safe integer range.');
      addEdge(graph, requestIndex.get(request.requestId)!, resourceIndex.get(resource.resourceId)!, 1, cost, {
        kind: 'assign',
        requestId: request.requestId,
        resourceId: resource.resourceId,
      });
    }
  }
  for (const resource of resourceOrder) {
    const units = freeUnits(resource);
    if (units > 0) addEdge(graph, resourceIndex.get(resource.resourceId)!, sink, units, 0);
  }
  minCostMaxFlow(graph, 0, sink);
  const allocations: Allocation[] = [];
  for (const edges of graph) {
    for (const edge of edges) {
      if (edge.kind === 'assign' && edge.cap === 0 && edge.requestId && edge.resourceId) {
        const request = ranked.find((item) => item.requestId === edge.requestId)!;
        const resource = resourceOrder.find((item) => item.resourceId === edge.resourceId)!;
        allocations.push({
          requestId: edge.requestId,
          resourceId: edge.resourceId,
          units: 1,
          travelSeconds: travel.get(`${request.zoneId}\0${resource.zoneId}`)!,
          waitingRank: ranks.get(edge.requestId)!,
        });
      }
    }
  }
  allocations.sort((a, b) => a.requestId.localeCompare(b.requestId));
  return { allocations, ranks };
}

function fcfs(
  eligible: SnapshotRequest[],
  resources: SnapshotResource[],
  travel: Map<string, number>,
  ranks: Map<string, number>,
): Allocation[] {
  const remaining = new Map(resources.map((resource) => [resource.resourceId, freeUnits(resource)]));
  const allocations: Allocation[] = [];
  for (const request of waitingOrder(eligible)) {
    const options = resources
      .filter((resource) => {
        if ((remaining.get(resource.resourceId) ?? 0) <= 0) return false;
        if (!categoryMatches(request.needType, resource.needType)) return false;
        if (!resource.available) return false;
        if (!capabilityMatches(request.requiresStepFree, resource.stepFree)) return false;
        return travel.has(`${request.zoneId}\0${resource.zoneId}`);
      })
      .sort((a, b) => {
        const ta = travel.get(`${request.zoneId}\0${a.zoneId}`)!;
        const tb = travel.get(`${request.zoneId}\0${b.zoneId}`)!;
        if (ta !== tb) return ta - tb;
        return a.resourceId.localeCompare(b.resourceId);
      });
    const chosen = options[0];
    if (!chosen) continue;
    remaining.set(chosen.resourceId, (remaining.get(chosen.resourceId) ?? 0) - 1);
    allocations.push({
      requestId: request.requestId,
      resourceId: chosen.resourceId,
      units: 1,
      travelSeconds: travel.get(`${request.zoneId}\0${chosen.zoneId}`)!,
      waitingRank: ranks.get(request.requestId) ?? 0,
    });
  }
  allocations.sort((a, b) => a.requestId.localeCompare(b.requestId));
  return allocations;
}

export function validateAllocations(allocations: Allocation[], snapshot: AllocationSnapshotInput): void {
  const requests = new Map(snapshot.requests.map((request) => [request.requestId, request]));
  const resources = new Map(snapshot.resources.map((resource) => [resource.resourceId, resource]));
  const seen = new Set<string>();
  const usage = new Map<string, number>();
  for (const allocation of allocations) {
    if (allocation.units !== 1) throw new SolverError('INVALID_SCHEMA', 'Allocation units must be 1.');
    if (seen.has(allocation.requestId)) throw new SolverError('INVALID_SCHEMA', 'Duplicate request assignment.');
    seen.add(allocation.requestId);
    const request = requests.get(allocation.requestId);
    const resource = resources.get(allocation.resourceId);
    if (!request || request.state !== 'ACKNOWLEDGED') throw new SolverError('INVALID_SCHEMA', 'Allocation request is not eligible.');
    if (!resource) throw new SolverError('INVALID_SCHEMA', 'Unknown resource.');
    if (!categoryMatches(request.needType, resource.needType)) throw new SolverError('INVALID_SCHEMA', 'Category mismatch.');
    if (!resource.available || !capabilityMatches(request.requiresStepFree, resource.stepFree)) {
      throw new SolverError('INVALID_SCHEMA', 'Resource is not suitable.');
    }
    usage.set(allocation.resourceId, (usage.get(allocation.resourceId) ?? 0) + 1);
  }
  for (const [resourceId, used] of usage) {
    const resource = resources.get(resourceId)!;
    if (used > freeUnits(resource)) throw new SolverError('INVALID_SCHEMA', 'Allocation exceeds free units.');
  }
}

function unmatchedFor(requests: SnapshotRequest[], resources: SnapshotResource[], allocations: Allocation[]): UnmatchedReason[] {
  const matched = new Set(allocations.map((allocation) => allocation.requestId));
  return requests
    .filter((request) => !matched.has(request.requestId))
    .map((request) => explainUnmatched(request, resources, allocations))
    .sort((a, b) => a.requestId.localeCompare(b.requestId) || a.reason.localeCompare(b.reason));
}

export function solve(snapshot: AllocationSnapshotInput): SolverSuccess {
  assertSnapshotShape(snapshot);
  const excluded = snapshot.requests
    .filter((request) => request.state !== 'ACKNOWLEDGED')
    .map((request) => ({
      requestId: request.requestId,
      reason: 'NOT_ACKNOWLEDGED' as ReasonCode,
      evidenceIds: [],
      detail: `${request.requestId} is ${request.state} and is outside this plan.`,
    }))
    .sort((a, b) => a.requestId.localeCompare(b.requestId));
  const eligible = snapshot.requests.filter((request) => request.state === 'ACKNOWLEDGED' && request.units === 1);
  const travel = travelLookup(snapshot);
  const flow = solveFlow(eligible, snapshot.resources, travel);
  validateAllocations(flow.allocations, { ...snapshot, requests: eligible });
  const baselineAllocations = fcfs(eligible, snapshot.resources, travel, flow.ranks);
  validateAllocations(baselineAllocations, { ...snapshot, requests: eligible });
  return {
    ok: true,
    allocations: flow.allocations,
    unmatched: unmatchedFor(eligible, snapshot.resources, flow.allocations),
    excluded,
    objective: objectiveOf(flow.allocations),
    baseline: {
      allocations: baselineAllocations,
      unmatched: unmatchedFor(eligible, snapshot.resources, baselineAllocations),
      objective: objectiveOf(baselineAllocations),
    },
    solverVersion: SOLVER_VERSION,
    policyId: POLICY_ID,
  };
}

export function permuteSnapshot<T>(items: T[], salt: number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = (index * 17 + salt * 13) % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}
