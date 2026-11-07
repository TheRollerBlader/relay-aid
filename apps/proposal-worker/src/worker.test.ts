import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POLICY_ID, type AllocationSnapshotInput, type SnapshotRequest } from '@relayaid/contracts';
import { DeterministicModel, runToolLoop, type ModelClient, type ToolCall } from './index';

function snapshot(): AllocationSnapshotInput {
  const raw = JSON.parse(readFileSync(new URL('../../../fixtures/synthetic-scenario.json', import.meta.url), 'utf8')) as AllocationSnapshotInput;
  return {
    ...raw,
    schemaVersion: 1,
    policyId: POLICY_ID,
    requests: raw.requests.map((request) => ({ ...request, units: 1 as const }) as SnapshotRequest),
  };
}

describe('proposal worker tools', () => {
  it('runs the six-tool deterministic rehearsal and stores the solver plan once', async () => {
    const seen: string[] = [];
    let stored = 0;
    const result = await runToolLoop({
      snapshot: snapshot(),
      model: new DeterministicModel(),
      persist: (draft) => {
        stored += 1;
        expect(draft.allocations.map((item) => [item.requestId, item.resourceId])).toEqual([
          ['r1', 'charging-b'],
          ['r2', 'charging-a'],
          ['r3', 'water-a'],
        ]);
        expect(draft.modelId).toBe('deterministic-tool-rehearsal');
        expect(draft.explanation.toLowerCase()).not.toContain('dispatched');
      },
    });
    expect(result.ok).toBe(true);
    expect(stored).toBe(1);
    expect(result.trace.map((entry) => entry.tool)).toEqual([
      'readRequests',
      'readResources',
      'solveAssignment',
      'compareWithBaseline',
      'explainUnmatched',
      'createProposedPlan',
    ]);
    void seen;
  });

  it('rejects unknown tools, extra properties, and a second invalid call', async () => {
    let stored = 0;
    const hostile: ModelClient = {
      id: 'hostile-fixture',
      live: false,
      async complete(): Promise<{ toolCalls: ToolCall[] }> {
        const step = hostileStep;
        hostileStep += 1;
        if (step === 0) return { toolCalls: [{ id: 'bad-1', name: 'approvePlan', arguments: { planId: 'x' } }] };
        if (step === 1) {
          return { toolCalls: [{ id: 'bad-2', name: 'readRequests', arguments: { snapshotId: snapshot().snapshotId, approve: true } }] };
        }
        return { toolCalls: [{ id: 'bad-3', name: 'dispatch', arguments: {} }] };
      },
    };
    let hostileStep = 0;
    const result = await runToolLoop({
      snapshot: snapshot(),
      model: hostile,
      persist: () => {
        stored += 1;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('TOOL_REJECTED');
    expect(stored).toBe(0);
    expect(result.trace.every((entry) => entry.accepted === false)).toBe(true);
  });

  it('caches a repeated tool-call id and does not create a second proposal', async () => {
    let step = 0;
    let stored = 0;
    const model: ModelClient = {
      id: 'repeat',
      live: false,
      async complete({ messages }) {
        step += 1;
        const snapshotId = 'demo-coverage-001';
        if (step === 1) return { toolCalls: [{ id: 'same', name: 'solveAssignment', arguments: { snapshotId, policyId: POLICY_ID } }] };
        if (step === 2) return { toolCalls: [{ id: 'same', name: 'solveAssignment', arguments: { snapshotId, policyId: 'other-policy' } }] };
        if (step === 3) {
          const last = JSON.parse(messages.at(-1)!.content) as { result?: { solutionId: string } };
          return {
            toolCalls: [
              {
                id: 'make',
                name: 'createProposedPlan',
                arguments: { solutionId: last.result?.solutionId, explanation: 'cached solve' },
              },
            ],
          };
        }
        return { toolCalls: [], finalText: 'done' };
      },
    };
    const result = await runToolLoop({
      snapshot: snapshot(),
      model,
      persist: () => {
        stored += 1;
      },
    });
    expect(result.ok).toBe(true);
    expect(stored).toBe(1);
  });
});
