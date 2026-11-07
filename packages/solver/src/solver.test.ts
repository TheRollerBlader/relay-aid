import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AllocationSnapshotInput, SnapshotRequest } from '@relayaid/contracts';
import { POLICY_ID } from '@relayaid/contracts';
import { permuteSnapshot, solve, SolverError, type SolverSuccess } from './index';

function fixture(): AllocationSnapshotInput {
  const raw = JSON.parse(readFileSync(new URL('../../../fixtures/synthetic-scenario.json', import.meta.url), 'utf8')) as {
    snapshotId: string;
    shelterId: string;
    allocationEpoch: string;
    policyId: string;
    capturedAt: string;
    requests: SnapshotRequest[];
    resources: AllocationSnapshotInput['resources'];
    travelSeconds: AllocationSnapshotInput['travelSeconds'];
  };
  return {
    schemaVersion: 1,
    snapshotId: raw.snapshotId,
    shelterId: raw.shelterId,
    allocationEpoch: raw.allocationEpoch,
    policyId: POLICY_ID,
    capturedAt: raw.capturedAt,
    requests: raw.requests.map((request) => ({ ...request, units: 1 as const })),
    resources: raw.resources,
    travelSeconds: raw.travelSeconds,
    omittedCount: 0,
  };
}

function signature(result: SolverSuccess): string {
  return JSON.stringify({
    allocations: result.allocations.map((item) => [item.requestId, item.resourceId]),
    unmatched: result.unmatched.map((item) => [item.requestId, item.reason]),
  });
}

describe('deterministic allocation', () => {
  it('matches the synthetic coverage scenario and beats FCFS without relaxing constraints', () => {
    const result = solve(fixture());
    expect(result.objective.matchCount).toBe(3);
    expect(result.baseline.objective.matchCount).toBe(2);
    expect(result.allocations.map((item) => [item.requestId, item.resourceId])).toEqual([
      ['r1', 'charging-b'],
      ['r2', 'charging-a'],
      ['r3', 'water-a'],
    ]);
    expect(result.unmatched).toEqual([
      expect.objectContaining({ requestId: 'r4', reason: 'CAPACITY_COMPETITION' }),
    ]);
    expect(result.baseline.allocations.map((item) => [item.requestId, item.resourceId])).toEqual([
      ['r1', 'charging-a'],
      ['r3', 'water-a'],
    ]);
    expect(result.baseline.objective.matchCount).toBeLessThan(result.objective.matchCount);
    expect(result.objective.waitingRankSum).toBe(0 + 1 + 2);
  });

  it('is identical when input arrays are permuted', () => {
    const base = fixture();
    const first = signature(solve(base));
    for (let salt = 1; salt <= 8; salt += 1) {
      const shuffled: AllocationSnapshotInput = {
        ...base,
        requests: permuteSnapshot(base.requests, salt),
        resources: permuteSnapshot(base.resources, salt + 3),
        travelSeconds: permuteSnapshot(base.travelSeconds, salt + 5),
      };
      expect(signature(solve(shuffled))).toBe(first);
    }
  });

  it('rejects missing travel instead of inventing a distance', () => {
    const snapshot = fixture();
    snapshot.travelSeconds = snapshot.travelSeconds.filter((hop) => hop.to !== 'far');
    expect(() => solve(snapshot)).toThrow(SolverError);
    try {
      solve(snapshot);
    } catch (error) {
      expect(error).toBeInstanceOf(SolverError);
      expect((error as SolverError).code).toBe('INPUT_INCOMPLETE');
    }
  });

  it('keeps inaccessible and wrong-category edges out', () => {
    const snapshot = fixture();
    snapshot.resources = [
      { ...snapshot.resources[0], resourceId: 'charging-a', stepFree: false, zoneId: 'near' },
      { ...snapshot.resources[2], available: false },
    ];
    const result = solve(snapshot);
    expect(result.allocations.find((item) => item.requestId === 'r2')).toBeUndefined();
    expect(result.unmatched.find((item) => item.requestId === 'r2')?.reason).toBe('CAPABILITY_UNAVAILABLE');
    expect(result.allocations.find((item) => item.resourceId === 'water-a')).toBeUndefined();
    const water = result.unmatched.find((item) => item.requestId === 'r3');
    expect(water?.reason).toBe('RESOURCE_UNAVAILABLE');
    expect(result.allocations.every((item) => item.resourceId !== 'water-a')).toBe(true);
  });

  it('returns a valid empty plan and does not invent resources', () => {
    const snapshot = fixture();
    const emptyRequests = solve({ ...snapshot, requests: [] });
    expect(emptyRequests.allocations).toEqual([]);
    expect(emptyRequests.objective.matchCount).toBe(0);
    const noResources = solve({ ...snapshot, resources: [] });
    expect(noResources.allocations).toEqual([]);
    expect(noResources.unmatched.every((item) => item.reason === 'NO_CATEGORY_RESOURCE')).toBe(true);
  });

  it('agrees with a brute-force objective on a small mixed graph', () => {
    const snapshot = fixture();
    const result = solve(snapshot);
    const best = brute(snapshot);
    expect(result.objective).toEqual(best);
  });

  it('solves the full declared batch size', () => {
    const requests: SnapshotRequest[] = Array.from({ length: 100 }, (_, index) => ({
      requestId: `q${index.toString().padStart(3, '0')}`,
      version: '1',
      state: 'ACKNOWLEDGED',
      needType: index % 2 === 0 ? 'WATER' : 'CHARGING',
      units: 1 as const,
      receivedAt: new Date(Date.UTC(2026, 10, 7, 12, 0, index)).toISOString(),
      zoneId: 'north',
      requiresStepFree: false,
    }));
    const resources = Array.from({ length: 30 }, (_, index) => ({
      resourceId: `pool-${index.toString().padStart(2, '0')}`,
      version: '1',
      needType: index < 15 ? ('WATER' as const) : ('CHARGING' as const),
      accountingMode: index < 15 ? ('CONSUMABLE' as const) : ('REUSABLE' as const),
      totalCapacity: index < 10 ? 4 : 2,
      reservedUnits: 0,
      consumedUnits: 0,
      available: true,
      stepFree: true,
      zoneId: 'near',
    }));
    const free = resources.reduce((sum, resource) => sum + resource.totalCapacity, 0);
    expect(free).toBeLessThanOrEqual(100);
    const started = Date.now();
    const result = solve({
      schemaVersion: 1,
      snapshotId: 'bench',
      shelterId: 'demo-shelter',
      allocationEpoch: '1',
      policyId: POLICY_ID,
      capturedAt: '2026-11-07T23:00:00.000Z',
      requests,
      resources,
      travelSeconds: [{ from: 'north', to: 'near', seconds: 90 }],
    });
    const elapsed = Date.now() - started;
    expect(result.allocations.length).toBeGreaterThan(0);
    expect(result.allocations.length).toBeLessThanOrEqual(free);
    expect(elapsed).toBeLessThan(2000);
  });
});

function brute(snapshot: AllocationSnapshotInput): SolverSuccess['objective'] {
  const eligible = snapshot.requests.filter((request) => request.state === 'ACKNOWLEDGED');
  const ranked = [...eligible].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.requestId.localeCompare(b.requestId));
  const rank = new Map(ranked.map((request, index) => [request.requestId, index]));
  const travel = new Map(snapshot.travelSeconds.map((hop) => [`${hop.from}\0${hop.to}`, hop.seconds]));
  let best = { matchCount: -1, waitingRankSum: Number.POSITIVE_INFINITY, travelSecondsSum: Number.POSITIVE_INFINITY };
  const usage = new Map(snapshot.resources.map((resource) => [resource.resourceId, 0]));
  const capacity = new Map(
    snapshot.resources.map((resource) => [resource.resourceId, resource.totalCapacity - resource.reservedUnits - resource.consumedUnits]),
  );
  const walk = (index: number, matchCount: number, rankSum: number, travelSum: number): void => {
    if (index === ranked.length) {
      if (
        matchCount > best.matchCount ||
        (matchCount === best.matchCount && rankSum < best.waitingRankSum) ||
        (matchCount === best.matchCount && rankSum === best.waitingRankSum && travelSum < best.travelSecondsSum)
      ) {
        best = { matchCount, waitingRankSum: rankSum, travelSecondsSum: travelSum };
      }
      return;
    }
    const request = ranked[index];
    walk(index + 1, matchCount, rankSum, travelSum);
    for (const resource of snapshot.resources) {
      if (resource.needType !== request.needType || !resource.available) continue;
      if (request.requiresStepFree && !resource.stepFree) continue;
      if ((usage.get(resource.resourceId) ?? 0) >= (capacity.get(resource.resourceId) ?? 0)) continue;
      const seconds = travel.get(`${request.zoneId}\0${resource.zoneId}`);
      if (seconds === undefined) continue;
      usage.set(resource.resourceId, (usage.get(resource.resourceId) ?? 0) + 1);
      walk(index + 1, matchCount + 1, rankSum + (rank.get(request.requestId) ?? 0), travelSum + seconds);
      usage.set(resource.resourceId, (usage.get(resource.resourceId) ?? 0) - 1);
    }
  };
  walk(0, 0, 0, 0);
  return best;
}
