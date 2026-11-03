import assert from 'node:assert/strict';

import codexCapacity, { codexItemOccupied } from '../agent/codex-capacity.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import openClawCapacity, { openClawItemOccupied } from '../agent/openclaw-capacity.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import { pickupIssueKey } from '../agent/project-pickup-capacity.ts';
import fixture from './project-pickup-selection-fixture.ts';

describe('project pickup capacity handoff', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should not reserve capacity for selection and retain only uncertain writes after closing in ${runtime}`, async () => {
      const f = fixture(runtime);
      const capacity = () =>
        runtime === 'codex'
          ? codexCapacity([], 1, f.state.projectPickup)
          : openClawCapacity([], 1, f.state.projectPickup);
      const selection = await f.select();
      assert.deepEqual(capacity(), { occupied: 0, available: 1 });
      f.clock.now = f.state.projectPickup!.operations[0]!.window.closesAt + 1;
      assert.deepEqual(capacity(), { occupied: 0, available: 1 });
      f.clock.now -= 2;
      f.client.assignProjectIssue = async () => {
        throw new Error('uncertain transport');
      };
      assert.equal((await f.run({ selection })).status, 'attempted');
      f.clock.now += 2;
      assert.deepEqual(capacity(), { occupied: 1, available: 0 });
    });

    it(`should recheck ordinary capacity before assignment after selection in ${runtime}`, async () => {
      const f = fixture(runtime);
      f.policy.maxConcurrentItems = 1;
      const selection = await f.select();
      f.state.records.push({ issueKey: 'ordinary', phase: 'assessing', request: {} });
      assert.equal((await f.run({ selection })).status, 'at-capacity');
      assert.equal(f.effects.writes, 0);
      assert.deepEqual(f.state.projectPickup!.operations, []);
      f.state.records = [];
      f.tx.runId = 'later-scan';
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
    });

    it(`should use native capacity for idle and busy pickup owners in ${runtime}`, async () => {
      const f = fixture(runtime);
      await f.run({ selection: await f.select() });
      const pickup = f.state.projectPickup!;
      const owner = {
        issueKey: pickupIssueKey(pickup, f.item.nodeId),
        projectWork: f.work(),
        phase: 'complete',
        request: {},
        nativeInactive: true,
        continuation: {
          phase: 'clarification-needed',
          result: { outcome: 'clarification-needed' },
        },
        work: { result: { outcome: 'clarification-needed' } },
      };
      const capacity = () =>
        runtime === 'codex'
          ? codexCapacity(f.state.records as DispatchRecord[], 1, pickup)
          : openClawCapacity(f.state.records as OpenClawDispatchRecord[], 1, pickup);
      f.tx.occupied = (record) =>
        runtime === 'codex'
          ? codexItemOccupied(record as DispatchRecord)
          : openClawItemOccupied(record as OpenClawDispatchRecord);
      f.state.records.push(owner);
      assert.deepEqual(capacity(), { occupied: 0, available: 1 });

      owner.nativeInactive = false;
      owner.phase = 'assessing';
      assert.deepEqual(capacity(), { occupied: 1, available: 0 });
      f.policy.maxConcurrentItems = 1;
      f.clock.now += 86400000;
      f.tx.runId = `scan-${f.clock.now}`;
      assert.equal((await f.run()).status, 'at-capacity');

      owner.phase = 'complete';
      owner.nativeInactive = true;
      const next = { ...structuredClone(f.item), nodeId: 'I_next', number: 99, assignees: [] };
      f.items.set(next.number, next);
      f.candidates.set(next.number, {
        ...structuredClone(f.candidates.get(f.item.number)!),
        nodeId: next.nodeId,
        number: next.number,
      });
      const selection = await f.run();
      assert.equal(selection.status, 'selection-required');
      assert.ok('digest' in selection);
      assert.equal(
        (
          await f.run({
            selection: {
              id: selection.id!,
              digest: selection.digest!,
              issueNodeId: next.nodeId,
              rationale: 'new eligible work while the earlier task waits for clarification',
            },
          })
        ).status,
        'assigned',
      );
      assert.equal(f.effects.writes, 2);
      assert.equal(owner.continuation.phase, 'clarification-needed');
      assert.deepEqual(capacity(), { occupied: 1, available: 0 });
    });
  }
});
