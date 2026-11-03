import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import projectPickup, { pickupAuthority } from '../agent/project-pickup.ts';
import { pickupOperationSchema } from '../agent/project-pickup-state.ts';
import pickupCapacity, { pickupIssueKey } from '../agent/project-pickup-capacity.ts';
import DiscoveryBudget from '../agent/discovery-budget.ts';
import reconcileProjectPickup from '../agent/project-pickup-reconcile.ts';
import { projectPickupPolicyDigest } from '../agent/project-pickup-authority.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import fixture from './project-pickup-selection-fixture.ts';

describe('agent/project-pickup', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should pass complete candidates and guidance to the model without selecting in ${runtime}`, async () => {
      const f = fixture(runtime);
      const result = await f.run();
      assert.equal(result.status, 'selection-required');
      assert.ok('candidates' in result && result.candidates?.[0]?.body);
      assert.ok('guidance' in result && result.guidance);
      assert.equal(f.effects.writes, 0);
    });

    it(`should discard prior scan material and load current guidance in ${runtime}`, async () => {
      const f = fixture(runtime);
      const old = await f.select();
      f.policy.projectPickup!.selection = { guidance: 'new priorities' };
      f.tx.runId = 'next-scan';
      const fresh = await f.run();
      assert.ok('guidance' in fresh && fresh.guidance === 'new priorities');
      assert.ok('id' in fresh && fresh.id !== old.id);
      assert.equal(f.state.projectPickup!.operations.length, 1);
      assert.equal((await f.run({ selection: old })).status, 'failed');
      assert.equal(f.effects.writes, 0);
    });

    it(`should accept edited content and verify eligibility only once before assignment in ${runtime}`, async () => {
      const f = fixture(runtime);
      const selection = await f.select();
      f.candidates.get(f.item.number)!.body += ' edited description';
      f.candidates.get(f.item.number)!.title = 'renamed';
      f.candidates.get(f.item.number)!.labels.push('documentation');
      const read = f.client.getItem;
      let before = 0;
      let after = 0;
      f.client.getItem = async (...args) => {
        if (f.effects.writes) assert.equal(++after, 1);
        else assert.equal(++before, 1);
        return read(...args);
      };
      f.client.projectCandidate = async () => {
        throw new Error('content must not be reread');
      };
      assert.equal((await f.run({ selection })).status, 'assigned');
      assert.equal(before, 1);
      assert.equal(after, 1);
      const retained = f.state.projectPickup!.operations[0]!;
      assert.deepEqual(retained.selected, { nodeId: f.item.nodeId, number: f.item.number });
      assert.deepEqual(retained.candidates, []);
      assert.equal(retained.guidance, undefined);
      assert.equal(retained.rationale, undefined);
      assert.equal(retained.beforeEvents, undefined);
      assert.ok(Value.Check(pickupOperationSchema, retained));
    });

    for (const reason of ['unknown', 'closed', 'assigned', 'milestone', 'stale']) {
      it(`should reject ${reason} selections without writing in ${runtime}`, async () => {
        const f = fixture(runtime);
        const selection = await f.select();
        if (reason === 'unknown') selection.issueNodeId = 'outside-list';
        if (reason === 'closed') f.item.state = 'closed';
        if (reason === 'assigned') f.item.assignees = [f.client.identity];
        if (reason === 'milestone') f.item.milestone = null;
        if (reason === 'stale') selection.digest = 'stale';
        assert.equal((await f.run({ selection })).status, 'failed');
        assert.equal(f.effects.writes, 0);
        assert.equal(f.state.projectPickup!.operations.length, 0);
      });
    }

    it(`should give dependency and label context to the model without hard exclusions in ${runtime}`, async () => {
      const f = fixture(runtime);
      f.client.projectBlocked = async () => true;
      f.candidates.get(f.item.number)!.labels.push('blocked');
      const result = await f.run();
      assert.equal(result.status, 'selection-required');
      assert.ok('candidates' in result && result.candidates?.[0]?.blockedByOpenIssues);
      assert.equal(f.effects.writes, 0);
      assert.equal(
        (await f.run({ selection: { ...(await f.select()), issueNodeId: null } })).status,
        'empty',
      );
      assert.deepEqual(f.state.projectPickup!.operations, []);
    });

    it(`should reconsider new issues after an empty scan in ${runtime}`, async () => {
      const f = fixture(runtime);
      const candidates = [...f.candidates.entries()];
      f.candidates.clear();
      assert.equal((await f.run()).status, 'empty');
      assert.deepEqual(f.state.projectPickup!.operations, []);
      for (const [number, candidate] of candidates) f.candidates.set(number, candidate);
      f.tx.runId = 'next-scan';
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
    });

    it(`should enforce one assignment per window after intake and completion in ${runtime}`, async () => {
      const f = fixture(runtime);
      await f.run({ selection: await f.select() });
      const work = f.work();
      f.state.records.push({
        issueKey: pickupIssueKey(f.state.projectPickup!, f.item.nodeId),
        projectWork: work,
        phase: 'complete',
        retired: {},
      });
      f.item.assignees = [];
      f.client.discoverProject = async () => {
        throw new Error('allowance is already consumed');
      };
      for (let scan = 2; scan <= 8; scan++) {
        f.tx.runId = `scan-${scan}`;
        assert.equal((await f.run()).status, 'allowance-reached');
      }
      assert.equal(f.effects.writes, 1);
      assert.deepEqual(f.state.projectPickup!.operations, []);
      assert.ok(f.state.projectPickup!.windowAssignment);
    });

    it(`should allow a fresh assignment in the next daily window in ${runtime}`, async () => {
      const f = fixture(runtime);
      await f.run({ selection: await f.select() });
      f.state.records.push({
        issueKey: pickupIssueKey(f.state.projectPickup!, f.item.nodeId),
        projectWork: f.work(),
        phase: 'complete',
        retired: {},
      });
      f.item.assignees = [];
      f.clock.now += 86400000;
      f.tx.runId = 'tomorrow';
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      assert.equal(f.effects.writes, 2);
    });

    it(`should preserve the used allowance across live target changes in ${runtime}`, async () => {
      const f = fixture(runtime);
      await f.run({ selection: await f.select() });
      f.policy.projectPickup!.projects[0]!.milestone.number = 11;
      f.milestone.number = 11;
      f.milestone.nodeId = 'M_next';
      f.item.milestone = { ...f.item.milestone!, number: 11, nodeId: 'M_next' };
      f.tx.runId = 'changed-target';
      assert.equal((await f.run()).status, 'allowance-reached');
      assert.equal(f.effects.writes, 1);
    });

    it(`should change an unused milestone without install in ${runtime}`, async () => {
      const f = fixture(runtime);
      const old = await f.select();
      f.policy.projectPickup!.projects[0]!.milestone.number = 11;
      f.milestone.number = 11;
      f.milestone.nodeId = 'M_next';
      f.item.milestone = { ...f.item.milestone!, number: 11, nodeId: 'M_next' };
      const fresh = await f.select();
      assert.notEqual(fresh.id, old.id);
      assert.equal((await f.run({ selection: fresh })).status, 'assigned');
    });

    for (const status of [401, 403, 404, 422, 429]) {
      it(`should preserve rejection ${status} and release pending capacity in ${runtime}`, async () => {
        const f = fixture(runtime);
        const assign = f.client.assignProjectIssue;
        const diagnostic = providerDiagnostic('github', 'api-request', 'unknown', {
          httpStatus: status,
          httpStatusSource: 'structured',
          providerMessage: 'GitHub rejected assignment',
        });
        f.client.assignProjectIssue = async () => {
          f.effects.writes++;
          throw new GitHubWorkEventClientError(
            'github-notification-request-failed',
            'rejected',
            {},
            undefined,
            diagnostic,
          );
        };
        const result = await f.run({ selection: await f.select() });
        assert.equal(result.status, 'failed');
        assert.ok('providerDiagnostic' in result && result.providerDiagnostic === diagnostic);
        assert.equal(pickupCapacity(f.state.records, f.state.projectPickup), 0);
        assert.deepEqual(pickupAuthority(f.state.projectPickup)!.withheldAssignments, []);
        assert.equal(f.state.projectPickup!.windowAssignment, undefined);
        f.client.assignProjectIssue = assign;
        f.tx.runId = 'later-scan';
        assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
        assert.equal(f.effects.writes, 2);
      });
    }

    for (const [status, source] of [
      [408, 'structured'],
      [500, 'structured'],
      [403, 'message'],
    ] as const) {
      it(`should reconcile uncertain ${status} from ${source} without another write in ${runtime}`, async () => {
        const f = fixture(runtime);
        const assign = f.client.assignProjectIssue;
        f.client.assignProjectIssue = async (...args) => {
          await assign(...args);
          throw new GitHubWorkEventClientError(
            'github-notification-request-failed',
            'unknown',
            {},
            undefined,
            providerDiagnostic('github', 'api-request', 'unknown', {
              httpStatus: status,
              httpStatusSource: source,
            }),
          );
        };
        assert.equal((await f.run({ selection: await f.select() })).status, 'attempted');
        const pending = f.state.projectPickup!.operations[0]!;
        assert.deepEqual(pending.candidates, []);
        assert.equal(pending.guidance, undefined);
        assert.equal(pending.rationale, undefined);
        assert.equal(pickupCapacity(f.state.records, f.state.projectPickup), 1);
        f.tx.runId = 'recover';
        assert.equal((await f.run()).status, 'assigned');
        assert.equal((await f.run()).status, 'allowance-reached');
        assert.equal(f.effects.writes, 1);
      });
    }

    it(`should retain an ambiguous absence across windows in ${runtime}`, async () => {
      const f = fixture(runtime);
      f.client.assignProjectIssue = async () => {
        f.effects.writes++;
        throw new Error('lost response');
      };
      await f.run({ selection: await f.select() });
      f.clock.now += 86400000;
      f.tx.runId = 'tomorrow';
      assert.equal((await f.run()).status, 'attempted');
      assert.equal(f.effects.writes, 1);
      assert.equal(f.state.projectPickup!.operations.length, 1);
    });

    it(`should keep old assignment custody while the live target changes in ${runtime}`, async () => {
      const f = fixture(runtime);
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw new Error('lost');
      };
      await f.run({ selection: await f.select() });
      const old = structuredClone(f.tx.enrollment);
      f.policy.projectPickup!.projects[0]!.milestone.number = 11;
      const enrollment = {
        ...old,
        milestoneNodeId: 'M_next',
        policyDigest: projectPickupPolicyDigest(f.policy),
      };
      await reconcileProjectPickup(
        f.state,
        f.tx.save,
        { enrollment, timezone: 'UTC', repository: 'owner/repo' },
        async () => {
          f.tx.enrollment = enrollment;
        },
      );
      assert.equal((await f.run()).status, 'assigned');
      assert.deepEqual(pickupAuthority(f.state.projectPickup)!.retained![0]!.enrollment, old);
      assert.equal(f.effects.writes, 1);
    });

    it(`should retain shared routing and capacity checks in ${runtime}`, async () => {
      const f = fixture(runtime);
      const selection = await f.select();
      f.policy.routing = [
        { match: 'owner/*', workflows: ['issue-assignment'], target: 'deny' },
        'owner/*',
      ];
      assert.equal((await f.run({ selection })).status, 'pending');
      assert.equal(f.effects.writes, 0);
      f.policy.routing = undefined;
      f.policy.maxConcurrentItems = 1;
      f.state.records.push({ issueKey: 'busy', phase: 'running', request: {} });
      assert.equal((await f.run()).status, 'at-capacity');
      f.state.records = [];
      f.tx.runId = 'later-scan';
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
    });

    it(`should stop before writing after the window closes or durable save fails in ${runtime}`, async () => {
      for (const reason of ['window', 'save']) {
        const f = fixture(runtime);
        const selection = await f.select();
        if (reason === 'window') {
          f.clock.now += 86400000 / 2;
          assert.equal((await f.run({ selection })).status, 'idle');
        } else {
          f.tx.save = async () => {
            throw new Error('disk unavailable');
          };
          await assert.rejects(f.run({ selection }), /disk unavailable/);
        }
        assert.equal(f.effects.writes, 0);
      }
    });

    it(`should defer unreadable issues but stop for account failures in ${runtime}`, async () => {
      const f = fixture(runtime);
      const read = f.client.getItem;
      f.client.getItem = async () => {
        throw new GitHubWorkEventClientError('github-notification-resource-missing', 'missing');
      };
      const result = await f.run();
      assert.equal(result.status, 'empty');
      assert.ok('summary' in result && result.summary?.skipped === 1);
      f.client.getItem = async () => {
        throw new GitHubWorkEventClientError(
          'github-notification-request-failed',
          'account unavailable',
        );
      };
      assert.equal((await f.run()).status, 'failed');
      f.client.getItem = read;
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
    });
  }

  it('should preserve provider eligibility when recovering an uncertain assignment', async () => {
    for (const reason of ['closed', 'archived', 'disabled'] as const) {
      const f = fixture();
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw Error('lost response');
      };
      assert.equal((await f.run({ selection: await f.select() })).status, 'attempted');
      if (reason === 'closed') f.item.state = 'closed';
      else f.input.repository[reason] = true;
      const result = await f.run();
      assert.equal(result.status, 'attempted');
      assert.ok('code' in result && result.code === 'project-pickup-assignment-unverified');
      assert.equal(f.effects.writes, 1);
      assert.equal(f.state.projectPickup!.operations[0]!.receipt, undefined);
    }
  });

  it('should withhold its admission receipt when another assignee replaces it', async () => {
    const f = fixture();
    const write = f.client.assignProjectIssue;
    const other = { login: 'another', nodeId: 'U_other', type: 'User' };
    f.client.assignProjectIssue = async (...args) => {
      await write(...args);
      f.item.assignees = [other];
    };
    const result = await f.run({ selection: await f.select() });
    assert.equal(result.status, 'attempted');
    assert.ok(f.item.assignees.some((entry) => entry.nodeId === other.nodeId));
    assert.equal(pickupAuthority(f.state.projectPickup)!.receipts.length, 0);
  });

  it('should reserve pickup only until ordinary intake takes custody', async () => {
    const f = fixture();
    await f.run({ selection: await f.select() });
    const pickup = f.state.projectPickup!;
    assert.equal(pickupCapacity([], pickup), 1);
    assert.equal(pickupCapacity([], pickup, f.item.nodeId), 0);
    f.state.records.push({
      projectWork: f.work(),
      phase: 'assessing',
      issueKey: pickupIssueKey(pickup, f.item.nodeId),
      request: {},
    });
    assert.equal(pickupCapacity(f.state.records, pickup), 0);
    assert.equal((await f.run()).status, 'allowance-reached');
    delete f.state.records[0]!.request;
    f.state.records[0]!.result = { outcome: 'clarification-needed' };
    assert.equal(pickupCapacity(f.state.records, pickup), 0);
    f.clock.now += 86400000;
    f.tx.runId = `scan-${f.clock.now}`;
    assert.equal((await f.run()).status, 'empty');
    assert.equal(f.effects.writes, 1);
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

  it('should resume a partial page within the same scan and discard it in the next', async () => {
    const f = fixture();
    const second = { ...f.item, number: f.item.number + 1, nodeId: 'I_second' };
    f.items.set(second.number, second);
    f.candidates.set(second.number, {
      ...f.candidates.get(f.item.number)!,
      number: second.number,
      nodeId: second.nodeId,
    });
    let time = 0;
    const read = f.client.projectCandidate;
    f.client.projectCandidate = async (...args) => {
      time += 21000;
      return read(...args);
    };
    const run = () =>
      projectPickup({
        ...f.tx,
        discoveryBudget: new DiscoveryBudget(20000, undefined, () => time),
      });
    // One read crosses the incidental budget; progress is still available in this scan.
    await run();
    assert.equal(f.state.projectPickup!.operations.length, 1);
    f.tx.runId = 'next-scan';
    await run();
    assert.equal(f.state.projectPickup!.operations.length, 1);
    assert.equal(f.state.projectPickup!.operations[0]!.runId, 'next-scan');
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

  it('should recover each durable boundary without replaying an attempted write', async () => {
    const baseline = fixture();
    let boundaryCount = 0;
    baseline.tx.save = async () => {
      boundaryCount++;
    };
    await baseline.run({ selection: await baseline.select() });
    for (let boundary = 1; boundary <= boundaryCount; boundary++)
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
        const uncertain =
          disk.projectPickup?.operations.some((op) => op.attemptedAt !== undefined) &&
          f.effects.writes === 0;
        f.tx.save = async () => {
          disk = structuredClone(f.state);
        };
        const recovered = await f.run();
        if (recovered.status === 'selection-required') await f.run({ selection: await f.select() });
        await f.run();
        assert.ok(f.effects.writes <= 1, `boundary ${boundary}, after ${after}`);
        if (uncertain) assert.equal(f.effects.writes, 0);
        else assert.equal(f.effects.writes, 1);
      }
  });

  it('should hold incomplete history and ambiguous assignment events', async () => {
    for (const reason of ['history', 'actor', 'duplicate']) {
      const f = fixture();
      const selection = await f.select();
      const write = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await write(...args);
        if (reason === 'history')
          f.client.listAssignmentEvents = async () => ({ events: f.events, truncated: true });
        if (reason === 'actor')
          f.events[0]!.actor = { login: 'other', nodeId: 'U_other', type: 'User' };
        if (reason === 'duplicate')
          f.events.push({ ...f.events[0]!, nodeId: 'E_other', databaseId: 2 });
      };
      assert.equal((await f.run({ selection })).status, 'attempted');
      f.clock.now += 86400000;
      f.tx.runId = `scan-${f.clock.now}`;
      await f.run();
      assert.equal(f.effects.writes, 1);
      assert.equal(pickupAuthority(f.state.projectPickup)!.receipts.length, 0);
    }
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
    assert.equal((await f.run()).status, 'allowance-reached');
    assert.equal(pickupCapacity(f.state.records, f.state.projectPickup), 1);
  });
});
