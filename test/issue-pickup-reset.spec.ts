import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import { pickupAuthority } from '../agent/issue-pickup.ts';
import { pickupIssueKey } from '../agent/issue-pickup-capacity.ts';
import resetIssuePickup from '../agent/issue-pickup-reset.ts';
import { issuePickupStateSchema } from '../agent/issue-pickup-state.ts';
import fixture from './issue-pickup-selection-fixture.ts';

describe('agent/issue-pickup-reset', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should discard discovery and preserve allowance and only unconsumed receipts in ${runtime}`, async () => {
      const f = fixture(runtime);
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      const original = structuredClone(f.state.projectPickup!);
      original.windowAssignment = {
        window: original.operations[0]!.window,
        assignedAt: f.clock.now,
      };
      original.operations.push({
        ...structuredClone(original.operations[0]!),
        id: 'scan',
        receipt: undefined,
        attemptedAt: undefined,
        phase: 'selecting',
        guidance: 'discard me',
      });
      const kept = resetIssuePickup(original, [])!;
      assert.equal(kept.operations.length, 1);
      assert.deepEqual(kept.charges, original.charges);
      assert.deepEqual(kept.windowAssignment, original.windowAssignment);
      assert.equal(pickupAuthority(kept)?.retained?.length, 1);
      assert.equal(original.operations.length, 2, 'projection must not mutate the source');
      assert.ok(Value.Check(issuePickupStateSchema, kept));
      const consumed = resetIssuePickup(original, [
        {
          issueKey: pickupIssueKey(original, f.item.nodeId),
          projectWork: f.work(),
        },
      ])!;
      assert.deepEqual(consumed.operations, []);
      f.state.projectPickup = consumed;
      f.tx.runId = 'after-reset';
      assert.equal((await f.run()).status, 'allowance-reached');
      assert.equal(f.effects.writes, 1);
      assert.equal(pickupAuthority(consumed)?.retained?.length, 0);
      f.clock.now += 86400000;
      f.tx.runId = 'tomorrow';
      await f.run();
      assert.deepEqual(f.state.projectPickup.charges, []);
    });

    it(`should reconcile retained uncertain writes without assigning again in ${runtime}`, async () => {
      const f = fixture(runtime);
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw new Error('response lost');
      };
      assert.equal((await f.run({ selection: await f.select() })).status, 'attempted');
      const pending = structuredClone(f.state.projectPickup!.operations[0]!);
      f.state.projectPickup = resetIssuePickup(f.state.projectPickup, [])!;
      const retained = f.state.projectPickup.operations[0]!;
      assert.deepEqual(retained.beforeEvents, pending.beforeEvents);
      assert.equal(retained.attemptedAt, pending.attemptedAt);
      assert.deepEqual(retained.selected, pending.selected);
      f.tx.runId = 'after-reset';
      assert.equal((await f.run()).status, 'assigned');
      assert.equal((await f.run()).status, 'allowance-reached');
      assert.equal(f.effects.writes, 1);
      assert.equal(pickupAuthority(f.state.projectPickup)?.retained?.length, 1);
    });
  }
});
