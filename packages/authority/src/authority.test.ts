import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEMO_IDS, type SubmitRequestV1 } from '@relayaid/contracts';
import { freeUnits } from '@relayaid/domain';
import { Authority, AuthorityError, solveSnapshot } from './index';

const IDS = DEMO_IDS.identities;
const SHELTER = DEMO_IDS.shelterId;

function submitBody(over: Partial<SubmitRequestV1> = {}): SubmitRequestV1 {
  return {
    schemaVersion: 1,
    commandId: randomUUID(),
    requestId: randomUUID(),
    localSequence: '1',
    needType: 'WATER',
    units: 1,
    deviceCreatedAt: '2026-11-07T23:05:00.000Z',
    ...over,
  };
}

describe('authoritative reducers', () => {
  it('accepts a station submit once and rejects a conflicting body', () => {
    const authority = Authority.demo();
    const body = submitBody();
    const first = authority.submitRequest(IDS.station, body);
    const replay = authority.submitRequest(IDS.station, body);
    expect(first.outcome).toBe('ACCEPTED');
    expect(replay).toMatchObject({ outcome: 'ACCEPTED', requestId: body.requestId, requestVersion: '1' });
    expect(Object.values(authority.state.requests).filter((request) => request.requestId === body.requestId)).toHaveLength(1);
    const otherCommand = submitBody({ commandId: randomUUID(), requestId: body.requestId, needType: 'CHARGING', localSequence: '1' });
    expect(() => authority.submitRequest(IDS.station, otherCommand)).toThrow(AuthorityError);
    expect(authority.state.requests[body.requestId].needType).toBe('WATER');
    const changedCommand = { ...body, needType: 'CHARGING' as const };
    expect(() => authority.submitRequest(IDS.station, changedCommand)).toThrow(/commandId/);
  });

  it('denies an unregistered identity and hides other stations', () => {
    const authority = Authority.demo();
    const before = Object.keys(authority.state.requests).length;
    expect(() => authority.submitRequest(IDS.outsider, submitBody())).toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(Object.keys(authority.state.requests)).toHaveLength(before);
    expect(() => authority.acknowledgeRequest(IDS.station, { requestId: DEMO_IDS.requests.r5, expectedVersion: '1', commandId: randomUUID() })).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => authority.approvePlan(IDS.worker, { planId: 'none', expectedPlanVersion: '1', commandId: randomUUID() })).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => authority.updateResource(IDS.worker, { resourceId: 'water-a', expectedVersion: '1', commandId: randomUUID(), available: false })).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );

    const otherIdentity = 'identity-station-b';
    authority.registerPrincipal(IDS.admin, { principalIdentity: otherIdentity, role: 'STATION', commandId: randomUUID() });
    authority.registerStation(IDS.admin, {
      commandId: randomUUID(),
      stationId: 'station-east',
      principalIdentity: otherIdentity,
      installationId: 'install-east',
      label: 'East station',
      zoneId: 'north',
      allowedCategories: ['WATER', 'CHARGING'],
    });
    const foreign = submitBody({ localSequence: '9' });
    authority.submitRequest(otherIdentity, foreign);
    const mine = authority.myStationRequests(IDS.station);
    expect(mine.requests.some((request) => request.requestId === foreign.requestId)).toBe(false);
    const theirs = authority.myStationRequests(otherIdentity);
    expect(theirs.requests.map((request) => request.requestId)).toEqual([foreign.requestId]);
  });

  it('acknowledges, assigns one manual unit, settles water and charging once, and rejects stale repeats', () => {
    let time = Date.parse('2026-11-07T23:00:00.000Z');
    const authority = Authority.demo(() => new Date(time).toISOString());
    const ack = authority.acknowledgeRequest(IDS.coordinator, { requestId: DEMO_IDS.requests.r5, expectedVersion: '1', commandId: randomUUID() });
    expect(ack.outcome).toBe('ACCEPTED');
    expect(authority.state.requests[DEMO_IDS.requests.r5].state).toBe('ACKNOWLEDGED');
    const stale = authority.acknowledgeRequest(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r5,
      expectedVersion: authority.state.requests[DEMO_IDS.requests.r5].version,
      commandId: randomUUID(),
    });
    expect(stale.errorCode).toBe('INVALID_TRANSITION');
    expect(authority.state.controls[SHELTER].allocationEpoch).not.toBe('42');

    const manual = authority.createManualPlan(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r3,
      resourceId: 'water-a',
      expectedRequestVersion: authority.state.requests[DEMO_IDS.requests.r3].version,
      commandId: randomUUID(),
    });
    expect(manual.outcome).toBe('ACCEPTED');
    const planId = manual.requestId!;
    const approved = authority.approvePlan(IDS.coordinator, { planId, expectedPlanVersion: '1', commandId: randomUUID() });
    expect(approved.outcome).toBe('ACCEPTED');
    expect(authority.state.resources['water-a'].reservedUnits).toBe(1);
    expect(freeUnits(authority.state.resources['water-a'])).toBe(0);
    const replay = authority.approvePlan(IDS.coordinator, { planId, expectedPlanVersion: '1', commandId: approved.commandId });
    expect(replay.outcome).toBe('ACCEPTED');
    expect(authority.state.resources['water-a'].reservedUnits).toBe(1);

    const assignmentId = authority.state.requests[DEMO_IDS.requests.r3].activeAssignmentId!;
    const completed = authority.completeAssignment(IDS.coordinator, {
      assignmentId,
      expectedAssignmentVersion: '1',
      expectedRequestVersion: authority.state.requests[DEMO_IDS.requests.r3].version,
      commandId: randomUUID(),
    });
    expect(completed.outcome).toBe('ACCEPTED');
    expect(authority.state.resources['water-a']).toMatchObject({ reservedUnits: 0, consumedUnits: 1 });
    const again = authority.completeAssignment(IDS.coordinator, {
      assignmentId,
      expectedAssignmentVersion: '2',
      expectedRequestVersion: completed.requestVersion!,
      commandId: randomUUID(),
    });
    expect(again.errorCode).toBe('INVALID_TRANSITION');
    expect(authority.state.resources['water-a'].consumedUnits).toBe(1);

    const charging = authority.createManualPlan(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r1,
      resourceId: 'charging-b',
      expectedRequestVersion: authority.state.requests[DEMO_IDS.requests.r1].version,
      commandId: randomUUID(),
    });
    authority.approvePlan(IDS.coordinator, { planId: charging.requestId!, expectedPlanVersion: '1', commandId: randomUUID() });
    const chargingAssignment = authority.state.requests[DEMO_IDS.requests.r1].activeAssignmentId!;
    authority.attachVolunteer(IDS.coordinator, {
      assignmentId: chargingAssignment,
      volunteerIdentity: IDS.volunteer,
      expectedAssignmentVersion: '1',
      commandId: randomUUID(),
    });
    expect(() =>
      authority.completeAssignment(IDS.volunteer, {
        assignmentId: authority.state.requests[DEMO_IDS.requests.r3].activeAssignmentId ?? assignmentId,
        expectedAssignmentVersion: '1',
        expectedRequestVersion: '1',
        commandId: randomUUID(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    authority.completeAssignment(IDS.volunteer, {
      assignmentId: chargingAssignment,
      expectedAssignmentVersion: '2',
      expectedRequestVersion: authority.state.requests[DEMO_IDS.requests.r1].version,
      commandId: randomUUID(),
    });
    expect(authority.state.resources['charging-b']).toMatchObject({ reservedUnits: 0, consumedUnits: 0 });
    expect(freeUnits(authority.state.resources['charging-b'])).toBe(1);
    expect(authority.state.volunteers[IDS.volunteer].activeAssignmentId).toBeNull();

    const cancelPlan = authority.createManualPlan(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r2,
      resourceId: 'charging-a',
      expectedRequestVersion: authority.state.requests[DEMO_IDS.requests.r2].version,
      commandId: randomUUID(),
    });
    authority.approvePlan(IDS.coordinator, { planId: cancelPlan.requestId!, expectedPlanVersion: '1', commandId: randomUUID() });
    authority.cancelRequest(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r2,
      expectedVersion: authority.state.requests[DEMO_IDS.requests.r2].version,
      commandId: randomUUID(),
      reason: 'Resident left the lobby',
    });
    expect(authority.state.resources['charging-a']).toMatchObject({ reservedUnits: 0, consumedUnits: 0 });
    const secondCancel = authority.cancelRequest(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r2,
      expectedVersion: authority.state.requests[DEMO_IDS.requests.r2].version,
      commandId: randomUUID(),
      reason: 'again',
    });
    expect(secondCancel.errorCode).toBe('INVALID_TRANSITION');
    expect(authority.state.resources['charging-a'].reservedUnits).toBe(0);
  });

  it('lets exactly one of two plans reserve the last water unit', async () => {
    const authority = Authority.demo();
    const first = authority.createManualPlan(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r3,
      resourceId: 'water-a',
      expectedRequestVersion: '2',
      commandId: randomUUID(),
    });
    const second = authority.createManualPlan(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r4,
      resourceId: 'water-a',
      expectedRequestVersion: '2',
      commandId: randomUUID(),
    });
    const results = await Promise.all([
      authority.run(() => authority.approvePlan(IDS.coordinator, { planId: first.requestId!, expectedPlanVersion: '1', commandId: randomUUID() })),
      authority.run(() => authority.approvePlan(IDS.coordinator, { planId: second.requestId!, expectedPlanVersion: '1', commandId: randomUUID() })),
    ]);
    const accepted = results.filter((result) => result.outcome === 'ACCEPTED');
    const rejected = results.filter((result) => result.outcome === 'REJECTED');
    expect(accepted).toHaveLength(1);
    expect(rejected[0].errorCode).toBe('STALE_PLAN');
    expect(authority.state.resources['water-a'].reservedUnits).toBe(1);
    expect(freeUnits(authority.state.resources['water-a'])).toBe(0);
    expect(authority.state.resources['water-a'].reservedUnits).toBeGreaterThanOrEqual(0);
  });

  it('rejects an expired snapshot and a plan whose epoch moved', () => {
    let time = Date.parse('2026-11-07T23:00:00.000Z');
    const authority = Authority.demo(() => new Date(time).toISOString());
    const created = authority.createManualPlan(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r3,
      resourceId: 'water-a',
      expectedRequestVersion: '2',
      commandId: randomUUID(),
    });
    time += 11 * 60 * 1000;
    const expired = authority.approvePlan(IDS.coordinator, { planId: created.requestId!, expectedPlanVersion: '1', commandId: randomUUID() });
    expect(expired.errorCode).toBe('EXPIRED_PLAN');
    expect(authority.state.resources['water-a'].reservedUnits).toBe(0);

    time = Date.parse('2026-11-07T23:00:00.000Z');
    const fresh = authority.createManualPlan(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r3,
      resourceId: 'water-a',
      expectedRequestVersion: '2',
      commandId: randomUUID(),
    });
    authority.updateResource(IDS.coordinator, { resourceId: 'water-a', expectedVersion: '1', commandId: randomUUID(), totalCapacity: 1 });
    const stale = authority.approvePlan(IDS.coordinator, { planId: fresh.requestId!, expectedPlanVersion: '1', commandId: randomUUID() });
    expect(stale.errorCode).toBe('STALE_PLAN');
    expect(authority.state.requests[DEMO_IDS.requests.r3].state).toBe('ACKNOWLEDGED');
  });

  it('shares the optimized path with manual approval and records the synthetic objective', () => {
    const authority = Authority.demo(() => '2026-11-07T23:10:00.000Z');
    const started = authority.startProposalRun(IDS.coordinator, { commandId: randomUUID(), mode: 'DETERMINISTIC' });
    const snapshot = authority.readSnapshot(IDS.worker, started.snapshotId)!;
    expect(snapshot.requests.map((request) => request.requestId)).not.toContain(DEMO_IDS.requests.r5);
    const solved = solveSnapshot(snapshot);
    expect(solved.objective.matchCount).toBe(3);
    expect(solved.baseline.objective.matchCount).toBe(2);
    expect(solved.unmatched.map((item) => item.reason)).toContain('CAPACITY_COMPETITION');
    authority.claimProposalRun(IDS.worker, { runId: started.runId, commandId: randomUUID() });
    const byId = new Map(snapshot.requests.map((request) => [request.requestId, request]));
    const resources = new Map(snapshot.resources.map((resource) => [resource.resourceId, resource]));
    const proposed = authority.createProposedPlan(IDS.worker, {
      planId: randomUUID(),
      runId: started.runId,
      commandId: randomUUID(),
      allocations: solved.allocations.map((allocation) => ({
        ...allocation,
        requestVersion: byId.get(allocation.requestId)!.version,
        resourceVersion: resources.get(allocation.resourceId)!.version,
      })),
      unmatched: solved.unmatched,
      objective: solved.objective,
      baseline: solved.baseline.objective,
      solverVersion: solved.solverVersion,
      explanation: 'Synthetic proposal',
      modelId: null,
    });
    expect(proposed.outcome).toBe('ACCEPTED');
    const approved = authority.approvePlan(IDS.coordinator, { planId: proposed.requestId!, expectedPlanVersion: '1', commandId: randomUUID() });
    expect(approved.outcome).toBe('ACCEPTED');
    expect(authority.state.resources['water-a'].reservedUnits).toBe(1);
    expect(authority.state.resources['charging-a'].reservedUnits).toBe(1);
    expect(authority.state.resources['charging-b'].reservedUnits).toBe(1);
    const assigned = Object.values(authority.state.requests).filter((request) => request.state === 'ASSIGNED');
    expect(assigned).toHaveLength(3);
    expect(authority.state.requests[DEMO_IDS.requests.r4].state).toBe('ACKNOWLEDGED');
    expect(authority.myVolunteerAssignments(IDS.volunteer).assignments).toHaveLength(0);
    expect(() => authority.coordinatorRequests(IDS.station)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => authority.workerSnapshots(IDS.coordinator)).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('rejects a newer total below reserved capacity and keeps the prior counters', () => {
    const authority = Authority.demo();
    const plan = authority.createManualPlan(IDS.coordinator, {
      requestId: DEMO_IDS.requests.r3,
      resourceId: 'water-a',
      expectedRequestVersion: '2',
      commandId: randomUUID(),
    });
    authority.approvePlan(IDS.coordinator, { planId: plan.requestId!, expectedPlanVersion: '1', commandId: randomUUID() });
    const rejected = authority.updateResource(IDS.coordinator, {
      resourceId: 'water-a',
      expectedVersion: authority.state.resources['water-a'].version,
      commandId: randomUUID(),
      totalCapacity: 0,
    });
    expect(rejected.errorCode).toBe('CAPACITY_EXCEEDED');
    expect(authority.state.resources['water-a'].totalCapacity).toBe(1);
    expect(authority.state.resources['water-a'].reservedUnits).toBe(1);
  });
});
