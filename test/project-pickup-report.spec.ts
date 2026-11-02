import assert from 'node:assert/strict';

import report, { type PickupReportRecord } from '../agent/project-pickup-report.ts';
import type { PickupReport } from '../agent/project-pickup-state.ts';
import { pickupIssueKey } from '../agent/project-pickup-capacity.ts';
import selectionFixture from './project-pickup-selection-fixture.ts';

describe('agent/project-pickup-report', () => {
  async function fixture() {
    const f = selectionFixture();
    await f.run({ selection: await f.select() });
    const pickup = f.state.projectPickup!;
    const records: PickupReportRecord[] = [];
    let previous: PickupReport | undefined;
    const run = (
      options: {
        status?: string;
        code?: string;
        runId?: string;
        debug?: boolean;
        capacity?: { occupied: number; limit: number };
      } = {},
    ) => {
      const result = report({
        policy: f.policy,
        pickup,
        records,
        previous,
        outcome: { status: options.status ?? 'assigned', code: options.code },
        now: f.clock.now,
        runId: options.runId,
        debug: options.debug,
        capacity: options.capacity,
        active: (record) =>
          record.nativeInactive === undefined ? undefined : !record.nativeInactive,
        conversation: (record) =>
          record.threadId ? `codex://threads/${record.threadId}` : undefined,
      });
      if (result.report) previous = result.report;
      return result;
    };
    const managed = (): PickupReportRecord => ({
      issueKey: pickupIssueKey(pickup, f.item.nodeId),
      projectWork: f.work(),
      phase: 'complete',
      progression: { stage: 'implementation' },
      continuation: { phase: 'running' },
      nativeInactive: false,
      threadId: 'issue-chat',
    });
    return { ...f, records, pickup, run, managed };
  }

  it(`should show selection and preserve native quiet behavior`, async () => {
    const f = await fixture();
    const selected = f.run();
    assert.equal(selected.notify, true);
    assert.match(selected.response, /> ## 💡/);
    assert.match(selected.response, /github\.com\/owner\/repo\/milestone\/10/);
    assert.match(selected.response, /Why selected/);
    assert.match(selected.response, /highest explicit priority/);
    assert.match(selected.response, /queued/);
    assert.doesNotMatch(selected.response, /Debug/);
    const quiet = f.run();
    assert.equal(quiet.notify, false);
    assert.equal(quiet.response, '');
  });

  it(`should show a blocker once and verified work recovery once`, async () => {
    const f = await fixture();
    const record = f.managed();
    record.continuation = { phase: 'blocked', code: 'implementation-fixture-blocked' };
    f.records.push(record);
    const blocked = f.run({ status: 'admitted' });
    assert.match(blocked.response, /> ## ⚠️/);
    assert.match(blocked.response, /`implementation-fixture-blocked`/);
    assert.match(blocked.response, /Next step/);
    assert.equal(f.run({ status: 'admitted' }).notify, false);
    record.continuation = { phase: 'running' };
    const recovered = f.run({ status: 'admitted' });
    assert.equal(recovered.notify, true);
    assert.match(recovered.response, /resumed/);
    assert.match(recovered.response, /running \(last observed\)/);
    assert.match(recovered.response, /codex:\/\/threads\/issue-chat/);
    assert.equal(f.run({ status: 'admitted' }).notify, false);
  });

  it(`should distinguish window closure from blocked, running and delivered work`, async () => {
    const f = await fixture();
    const record = f.managed();
    f.records.push(record);
    f.run({ status: 'admitted' });
    f.clock.now = f.pickup.operations[0]!.window.closesAt;
    const closed = f.run({ status: 'admitted' });
    assert.equal(closed.notify, true);
    assert.match(closed.response, /Window closed/);
    assert.match(closed.response, /running \(last observed\)/);
    assert.match(closed.response, /does not mean completion/);
    assert.equal(f.run({ status: 'admitted' }).notify, false);
    record.continuation = { phase: 'blocked' };
    assert.match(f.run({ status: 'admitted' }).response, /blocked/);
    record.continuation = { phase: 'complete', result: { outcome: 'done' } };
    record.delivery = {
      pullRequest: { pullRequestNumber: 42 },
      reconciled: true,
      attached: true,
      cardAttempts: 1,
      announcement: { receipt: {} },
    };
    const delivered = f.run({ status: 'completed' });
    assert.match(delivered.response, /PR delivery.*\/pull\/42.*delivered/);
    assert.match(delivered.response, /does not mean completion/);
  });

  it(`should replay a prepared occurrence after restart without inventing another report`, async () => {
    const f = await fixture();
    const selected = f.run({ runId: 'native-1' });
    f.clock.now += 7200000;
    const replay = report({
      policy: f.policy,
      pickup: f.pickup,
      records: [],
      previous: structuredClone(selected.report),
      outcome: { status: 'assigned' },
      now: f.clock.now,
      runId: 'native-1',
      active: () => undefined,
      conversation: () => undefined,
    });
    assert.equal(replay.response, selected.response);
    assert.equal(f.run({ runId: 'native-2' }).notify, true);
    assert.equal(f.effects.writes, 1);
  });

  it(`should keep intermediate output private and render diagnostics only with debug`, async () => {
    const f = await fixture();
    assert.equal(f.run({ status: 'selection-required' }).response, '');
    f.pickup.operations[0]!.rationale = 'use [link](bad) and `literal`\nnot another card';
    const result = f.run({ debug: true });
    assert.match(result.response, /\\\[link\\\]/);
    assert.match(result.response, /\\`literal\\`/);
    assert.match(result.response, /> ## 🔬 Debug/);
    assert.match(result.response, /`assigned`/);
    assert.equal(f.run({ debug: false }).notify, false);
  });

  it(`should not call unknown native activity running`, async () => {
    const f = await fixture();
    const record = f.managed();
    delete record.nativeInactive;
    f.records.push(record);
    assert.match(f.run().response, /activity unknown/);
    record.nativeInactive = true;
    assert.match(f.run().response, /queued/);
  });

  it('should report a new selection separately from an older closed window', async () => {
    const f = await fixture();
    const next = structuredClone(f.pickup.operations[0]!);
    next.id = 'next-window';
    next.window = {
      id: 'next',
      opensAt: next.window.opensAt + 86400000,
      closesAt: next.window.closesAt + 86400000,
    };
    next.selected!.number = 43;
    f.pickup.operations.push(next);
    f.clock.now += 86400000;
    const selected = f.run({ capacity: { occupied: 3, limit: 2 } });
    assert.match(selected.response, /> ## 💡 Project pickup selected/);
    assert.match(selected.response, /3\/2 occupied/);
    assert.doesNotMatch(selected.response, /\*\*Window closed/);
  });

  it('should keep an existing pr link while new work runs without reviving stale diagnostics', async () => {
    const f = await fixture();
    const record = f.managed();
    record.work = { code: 'implementation-result-missing' };
    record.delivery = { pullRequest: { pullRequestNumber: 42 }, reconciled: true };
    f.records.push(record);
    const running = f.run({ status: 'admitted' });
    assert.match(running.response, /running \(last observed\)/);
    assert.match(running.response, /PR delivery.*existing PR/);
    assert.doesNotMatch(running.response, /implementation-result-missing|response pending|⚠️/);
  });
});
