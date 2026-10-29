import assert from 'node:assert/strict';

import pickupCapacity, { pickupIssueKey } from '../agent/project-pickup-capacity.ts';
import { pickupAuthority } from '../agent/project-pickup.ts';
import fixture from './project-pickup-selection-fixture.ts';

describe('agent/project-pickup', () => {
  it('should retain guidance and evidence for native selection, never pick oldest by default', async () => {
    const f = fixture();
    const result = await f.run();
    assert.equal(result.status, 'selection-required');
    assert.equal(f.effects.writes, 0);
    assert.ok('guidance' in result && result.guidance?.includes('ready'));
    assert.ok('candidates' in result && result.candidates?.[0]?.labels.includes('priority: high'));
    assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
    assert.equal(f.effects.writes, 1);
    assert.equal(pickupAuthority(f.state.projectPickup)!.receipts.length, 1);
    await f.run();
    assert.equal(f.effects.writes, 1);
  });

  it('should reconcile a lost successful response without repeating assignment', async () => {
    const f = fixture();
    const write = f.client.assignProjectIssue;
    f.client.assignProjectIssue = async (...args) => {
      await write(...args);
      throw new Error('lost response');
    };
    assert.equal((await f.run({ selection: await f.select() })).status, 'attempted');
    f.clock.now += 7200000;
    assert.equal((await f.run()).status, 'assigned');
    assert.equal(f.effects.writes, 1);
    assert.equal(pickupAuthority(f.state.projectPickup)!.receipts.length, 1);
  });

  it('should hold ambiguous absence across windows rather than replay or consume another item', async () => {
    const f = fixture();
    f.client.assignProjectIssue = async () => {
      f.effects.writes++;
      throw new Error('uncertain');
    };
    await f.run({ selection: await f.select() });
    f.clock.now += 86400000;
    assert.equal((await f.run()).status, 'attempted');
    assert.equal(f.effects.writes, 1);
    assert.equal(f.state.projectPickup!.operations.length, 1);
  });

  it('should reject stale selection, changed evidence, ownership and closed milestones', async () => {
    for (const change of ['stale', 'body', 'owner', 'milestone'] as const) {
      const f = fixture();
      const selection = await f.select();
      if (change === 'stale') selection.digest = 'old';
      if (change === 'body') f.candidates.get(f.item.number)!.body += ' changed';
      if (change === 'owner')
        f.item.assignees = [{ login: 'another', nodeId: 'U_other', type: 'User' }];
      if (change === 'milestone') f.milestone.state = 'closed';
      assert.equal((await f.run({ selection })).status, 'failed');
      assert.equal(f.effects.writes, 0);
    }
  });

  it('should preserve a competing assignee and withhold its admission receipt', async () => {
    const f = fixture();
    const write = f.client.assignProjectIssue;
    const other = { login: 'another', nodeId: 'U_other', type: 'User' };
    f.client.assignProjectIssue = async (...args) => {
      await write(...args);
      f.item.assignees.push(other);
    };
    const result = await f.run({ selection: await f.select() });
    assert.equal(result.status, 'attempted');
    assert.ok(f.item.assignees.some((entry) => entry.nodeId === other.nodeId));
    assert.equal(pickupAuthority(f.state.projectPickup)!.receipts.length, 0);
  });

  it('should skip blocked, owned, managed and out-of-milestone work', async () => {
    for (const reason of ['blocked', 'owned', 'managed', 'milestone'] as const) {
      const f = fixture();
      if (reason === 'blocked') f.client.projectBlocked = async () => true;
      if (reason === 'owned') f.item.assignees = [f.client.identity];
      if (reason === 'managed') {
        await f.run();
        f.state.records.push({
          phase: 'complete',
          issueKey: pickupIssueKey(f.state.projectPickup!, f.item.nodeId),
        });
        f.state.projectPickup = undefined;
      }
      if (reason === 'milestone' && f.item.itemType === 'issue') f.item.milestone = null;
      assert.equal((await f.run()).status, 'empty');
      assert.equal(f.effects.writes, 0);
    }
  });

  it('should count queued pickup and unfinished work once through transfer and blocked outcomes', async () => {
    const f = fixture();
    await f.run({ selection: await f.select() });
    const pickup = f.state.projectPickup!;
    assert.equal(pickupCapacity([], pickup, f.tx.occupied), 1);
    assert.equal(pickupCapacity([], pickup, f.tx.occupied, f.item.nodeId), 0);
    f.state.records.push({
      projectWork: f.work(),
      phase: 'assessing',
      issueKey: pickupIssueKey(pickup, f.item.nodeId),
      request: {},
    });
    assert.equal(pickupCapacity(f.state.records, pickup, f.tx.occupied), 0);
    assert.equal((await f.run()).status, 'admitted');
    delete f.state.records[0]!.request;
    f.state.records[0]!.result = { outcome: 'clarification-needed' };
    assert.equal(pickupCapacity(f.state.records, pickup, f.tx.occupied), 1);
    f.clock.now += 86400000;
    assert.equal((await f.run()).status, 'admitted');
    assert.equal(f.effects.writes, 1);
  });

  it('should not refill a completed window, but permit the next window after completion', async () => {
    const f = fixture();
    await f.run({ selection: await f.select() });
    f.state.records.push({
      phase: 'complete',
      issueKey: pickupIssueKey(f.state.projectPickup!, f.item.nodeId),
      projectWork: f.work(),
      continuation: { phase: 'complete', scope: 'local', result: { outcome: 'done' } },
    });
    assert.equal((await f.run()).status, 'idle');
    f.clock.now += 86400000;
    assert.equal((await f.run()).status, 'empty');
    assert.equal(f.state.projectPickup!.operations.length, 2);
  });

  it('should preserve pause, cancellation and the window fence', async () => {
    const f = fixture();
    const selection = await f.select();
    f.policy.projectPickup!.paused = true;
    assert.equal((await f.run({ selection })).status, 'paused');
    f.policy.projectPickup!.paused = false;
    assert.equal((await f.run({ cancel: selection.id })).status, 'cancelled');
    assert.equal((await f.run({ selection })).status, 'idle');
    assert.equal(f.effects.writes, 0);
  });

  it('should not assign after the window expires during selection or revalidation', async () => {
    const f = fixture();
    const selection = await f.select();
    f.client.listAssignmentEvents = async () => {
      f.clock.now += 7200000;
      return { events: [], truncated: false };
    };
    assert.equal((await f.run({ selection })).status, 'expired');
    assert.equal(f.effects.writes, 0);
  });

  it('should retain paginated discovery and never rank an incomplete snapshot', async () => {
    const f = fixture();
    f.client.discoverProject = async (_o, _n, _m, page) => ({
      candidates: [...f.candidates.values()],
      ...(page < 2 ? { nextPage: 2 } : {}),
    });
    assert.equal((await f.run()).status, 'discovering');
    assert.equal((await f.run()).status, 'selection-required');
    assert.equal(f.state.projectPickup!.operations[0]!.candidates.length, 1);
  });

  it('should stop before assignment when reservation persistence fails', async () => {
    const f = fixture();
    const selection = await f.select();
    f.tx.save = async () => {
      throw new Error('disk failed');
    };
    await assert.rejects(f.run({ selection }), /disk failed/);
    assert.equal(f.effects.writes, 0);
  });
  it('should recover each durable boundary without replaying an attempted write', async () => {
    for (const boundary of [1, 2, 3, 4, 5])
      for (const after of [false, true]) {
        const f = fixture();
        let disk = structuredClone(f.state);
        let saves = 0;
        f.tx.save = async () => {
          saves++;
          if (saves === boundary && !after) throw new Error('disk failed');
          disk = structuredClone(f.state);
          if (saves === boundary && after) throw new Error('response lost');
        };
        await assert.rejects(async () => f.run({ selection: await f.select() }));
        delete f.state.projectPickup;
        Object.assign(f.state, structuredClone(disk));
        f.tx.save = async () => {
          disk = structuredClone(f.state);
        };
        const recovered = await f.run();
        if (recovered.status === 'selection-required') await f.run({ selection: await f.select() });
        await f.run();
        assert.ok(f.effects.writes <= 1, `boundary ${boundary}, after ${after}`);
        if (boundary === 4 && after) assert.equal(f.effects.writes, 0);
        else assert.equal(f.effects.writes, 1);
      }
  });

  it('should hold incomplete history and late or ambiguous assignment events', async () => {
    for (const reason of ['history', 'late', 'actor', 'duplicate']) {
      const f = fixture();
      const selection = await f.select();
      const write = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await write(...args);
        if (reason === 'history')
          f.client.listAssignmentEvents = async () => ({ events: f.events, truncated: true });
        if (reason === 'late')
          f.events[0]!.createdAt = new Date(
            f.state.projectPickup!.operations[0]!.window.closesAt,
          ).toISOString();
        if (reason === 'actor')
          f.events[0]!.actor = { login: 'other', nodeId: 'U_other', type: 'User' };
        if (reason === 'duplicate')
          f.events.push({ ...f.events[0]!, nodeId: 'E_other', databaseId: 2 });
      };
      assert.equal((await f.run({ selection })).status, 'attempted');
      f.clock.now += 86400000;
      await f.run();
      assert.equal(f.effects.writes, 1);
      assert.equal(pickupAuthority(f.state.projectPickup)!.receipts.length, 0);
    }
  });

  it('should release no-selection windows and reject unknown choices without assignment', async () => {
    for (const issueNodeId of [null, 'I_unknown']) {
      const f = fixture();
      const selection = { ...(await f.select()), issueNodeId };
      assert.equal((await f.run({ selection })).status, issueNodeId === null ? 'empty' : 'failed');
      assert.equal(f.effects.writes, 0);
    }
  });
  it('should retain occupied retirement and release the pilot after native retirement completes', async () => {
    const f = fixture();
    await f.run({ selection: await f.select() });
    f.state.records.push({
      phase: 'complete',
      retired: {},
      projectWork: f.work(),
      request: {},
      issueKey: pickupIssueKey(f.state.projectPickup!, f.item.nodeId),
    });
    f.clock.now += 86400000;
    assert.equal((await f.run()).status, 'admitted');
    delete f.state.records[0]!.request;
    assert.equal((await f.run()).status, 'empty');
    assert.equal(f.state.projectPickup!.operations[0]!.phase, 'cancelled');
    assert.equal(f.effects.writes, 1);
  });
  it('should not transfer a new pickup into an older retired assignment of the same issue', async () => {
    const f = fixture();
    await f.run({ selection: await f.select() });
    const work = f.work();
    work.pickup = { ...work.pickup!, assignmentNodeId: 'E_old' };
    f.state.records.push({
      phase: 'complete',
      retired: {},
      projectWork: work,
      issueKey: pickupIssueKey(f.state.projectPickup!, f.item.nodeId),
    });
    assert.equal((await f.run()).status, 'assigned');
    assert.equal(pickupCapacity(f.state.records, f.state.projectPickup, f.tx.occupied), 1);
  });
  it('should retain cancellation evidence when ordinary window history is pruned', async () => {
    const f = fixture();
    const selection = await f.select();
    await f.run({ selection });
    await f.run({ cancel: selection.id });
    for (let day = 0; day < 33; day++) {
      f.clock.now += 86400000;
      await f.run();
    }
    assert.deepEqual(pickupAuthority(f.state.projectPickup)!.withheldAssignments, [
      { issueNodeId: f.item.nodeId, assignmentNodeId: f.events[0]!.nodeId },
    ]);
    assert.equal(f.effects.writes, 1);
  });
});
