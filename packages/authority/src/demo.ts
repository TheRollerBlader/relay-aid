import { createHash } from 'node:crypto';
import { DEMO_IDS, POLICY_ID } from '@relayaid/contracts';
import type { AuthorityState, RequestRow, ResourceRow } from './types';
import { emptyState } from './types';

const IDS = DEMO_IDS;

function request(partial: Pick<RequestRow, 'requestId' | 'needType' | 'receivedAt' | 'state' | 'requiresStepFree'>): RequestRow {
  return {
    requestId: partial.requestId,
    stationId: IDS.stationId,
    shelterId: IDS.shelterId,
    localSequence: `seed-${partial.requestId.slice(-2)}`,
    needType: partial.needType,
    units: 1,
    requiresStepFree: partial.requiresStepFree,
    zoneId: 'north',
    receivedAt: partial.receivedAt,
    deviceCreatedAt: partial.receivedAt,
    state: partial.state,
    version: partial.state === 'NEW' ? '1' : '2',
    activeAssignmentId: null,
    acknowledgedBy: partial.state === 'NEW' ? null : IDS.identities.coordinator,
    acknowledgedAt: partial.state === 'NEW' ? null : '2026-11-07T22:30:00.000Z',
    linkedParentId: null,
    canonicalSubmit: null,
  };
}

export function buildDemoState(): AuthorityState {
  const state = emptyState();
  const shelter = IDS.shelterId;
  state.principals = {
    [IDS.identities.admin]: { identity: IDS.identities.admin, role: 'ADMIN', shelterId: shelter, enabled: true, version: '1' },
    [IDS.identities.coordinator]: { identity: IDS.identities.coordinator, role: 'COORDINATOR', shelterId: shelter, enabled: true, version: '1' },
    [IDS.identities.station]: { identity: IDS.identities.station, role: 'STATION', shelterId: shelter, enabled: true, version: '1' },
    [IDS.identities.volunteer]: { identity: IDS.identities.volunteer, role: 'VOLUNTEER', shelterId: shelter, enabled: true, version: '1' },
    [IDS.identities.worker]: { identity: IDS.identities.worker, role: 'WORKER', shelterId: shelter, enabled: true, version: '1' },
  };
  state.stations[IDS.stationId] = {
    stationId: IDS.stationId,
    principalIdentity: IDS.identities.station,
    installationId: 'install-lobby-001',
    shelterId: shelter,
    label: 'Lobby station',
    zoneId: 'north',
    allowedCategories: ['WATER', 'CHARGING'],
    enabled: true,
    version: '1',
  };
  state.volunteers[IDS.identities.volunteer] = {
    principalIdentity: IDS.identities.volunteer,
    shelterId: shelter,
    displayLabel: 'Volunteer North',
    available: true,
    activeAssignmentId: null,
    version: '1',
  };
  const resources: ResourceRow[] = [
    {
      resourceId: 'charging-a',
      shelterId: shelter,
      label: 'Step-free outlet, near desk',
      needType: 'CHARGING',
      accountingMode: 'REUSABLE',
      totalCapacity: 1,
      reservedUnits: 0,
      consumedUnits: 0,
      available: true,
      stepFree: true,
      zoneId: 'near',
      version: '1',
    },
    {
      resourceId: 'charging-b',
      shelterId: shelter,
      label: 'Standard outlet, far wall',
      needType: 'CHARGING',
      accountingMode: 'REUSABLE',
      totalCapacity: 1,
      reservedUnits: 0,
      consumedUnits: 0,
      available: true,
      stepFree: false,
      zoneId: 'far',
      version: '1',
    },
    {
      resourceId: 'water-a',
      shelterId: shelter,
      label: 'Bottled water, near desk',
      needType: 'WATER',
      accountingMode: 'CONSUMABLE',
      totalCapacity: 1,
      reservedUnits: 0,
      consumedUnits: 0,
      available: true,
      stepFree: true,
      zoneId: 'near',
      version: '1',
    },
  ];
  for (const resource of resources) state.resources[resource.resourceId] = resource;
  const rows = [
    request({ requestId: IDS.requests.r1, needType: 'CHARGING', receivedAt: '2026-11-07T22:00:00.000Z', state: 'ACKNOWLEDGED', requiresStepFree: false }),
    request({ requestId: IDS.requests.r2, needType: 'CHARGING', receivedAt: '2026-11-07T22:01:00.000Z', state: 'ACKNOWLEDGED', requiresStepFree: true }),
    request({ requestId: IDS.requests.r3, needType: 'WATER', receivedAt: '2026-11-07T22:02:00.000Z', state: 'ACKNOWLEDGED', requiresStepFree: false }),
    request({ requestId: IDS.requests.r4, needType: 'WATER', receivedAt: '2026-11-07T22:03:00.000Z', state: 'ACKNOWLEDGED', requiresStepFree: false }),
    request({ requestId: IDS.requests.r5, needType: 'WATER', receivedAt: '2026-11-07T22:04:00.000Z', state: 'NEW', requiresStepFree: false }),
  ];
  for (const row of rows) {
    state.requests[row.requestId] = row;
    state.events.push({
      eventId: `seed-${row.requestId}`,
      requestId: row.requestId,
      version: '1',
      kind: 'CREATED',
      actorIdentity: IDS.identities.station,
      serverTime: row.receivedAt,
      reasonCode: null,
      commandId: `seed-${row.requestId}`,
    });
    if (row.state === 'ACKNOWLEDGED') {
      state.events.push({
        eventId: `seed-ack-${row.requestId}`,
        requestId: row.requestId,
        version: '2',
        kind: 'ACKNOWLEDGED',
        actorIdentity: IDS.identities.coordinator,
        serverTime: row.acknowledgedAt ?? row.receivedAt,
        reasonCode: null,
        commandId: `seed-ack-${row.requestId}`,
      });
    }
  }
  state.controls[shelter] = { shelterId: shelter, allocationEpoch: '42', policyVersion: '1' };
  state.travelSeconds = [
    { shelterId: shelter, from: 'north', to: 'near', seconds: 60 },
    { shelterId: shelter, from: 'north', to: 'far', seconds: 180 },
  ];
  state.audits.push({
    auditId: 'seed-audit',
    shelterId: shelter,
    action: 'SEED',
    actorIdentity: IDS.identities.admin,
    targetId: 'demo-coverage-001',
    reason: `Synthetic scenario ${POLICY_ID}`,
    serverTime: '2026-11-07T22:30:00.000Z',
    commandId: null,
  });
  return state;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
