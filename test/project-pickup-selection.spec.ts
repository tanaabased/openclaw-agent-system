import reconcileProjectPickup from '../agent/project-pickup-reconcile.ts';
import {
  projectPickupPolicyDigest,
  default as authorizeProjectAssignment,
} from '../agent/project-pickup-authority.ts';
import assert from 'node:assert/strict';

import pickupCapacity, { pickupIssueKey } from '../agent/project-pickup-capacity.ts';
import projectPickup, { pickupAuthority } from '../agent/project-pickup.ts';
import DiscoveryBudget from '../agent/discovery-budget.ts';
import { pickupOperationSchema } from '../agent/project-pickup-state.ts';
import { Value } from 'typebox/value';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import fixture from './project-pickup-selection-fixture.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import normalizeSchedule from '../manifest/automation-schedule.ts';

describe('agent/project-pickup', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should verify selection once and confirm without rereading candidate content in ${runtime}`, async () => {
      const f = fixture(runtime);
      const selection = await f.select();
      const readItem = f.client.getItem;
      const readCandidate = f.client.projectCandidate;
      let beforeWrite = 0;
      let afterWrite = 0;
      f.client.getItem = async (...args) => {
        if (f.effects.writes) assert.equal(++afterWrite, 1, 'duplicate confirmation read');
        else assert.equal(++beforeWrite, 1, 'duplicate eligibility read');
        return readItem(...args);
      };
      f.client.projectCandidate = async (...args) => {
        assert.equal(f.effects.writes, 0, 'confirmation does not need candidate content');
        return readCandidate(...args);
      };
      assert.equal((await f.run({ selection })).status, 'assigned');
      assert.equal(beforeWrite, 1);
      assert.equal(afterWrite, 1);
      assert.equal(f.effects.writes, 1);
    });

    for (const status of [401, 403, 404, 422, 429]) {
      it(`should preserve github rejection ${status} without reserving uncertain work in ${runtime}`, async () => {
        const f = fixture(runtime);
        const selection = await f.select();
        const assign = f.client.assignProjectIssue;
        const diagnostic = providerDiagnostic('github', 'api-request', 'unknown', {
          httpStatus: status,
          httpStatusSource: 'structured',
          providerMessage: 'GitHub rejected this assignment',
          retryAfterMs: status === 429 ? 60000 : null,
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
        const result = await f.run({ selection });
        assert.equal(result.status, 'failed');
        assert.ok('code' in result && result.code === 'github-notification-request-failed');
        const operation = f.state.projectPickup!.operations[0]!;
        assert.deepEqual(operation.providerDiagnostic, diagnostic);
        assert.equal(operation.attemptedAt, undefined);
        assert.equal(pickupCapacity(f.state.records, f.state.projectPickup), 0);
        assert.deepEqual(pickupAuthority(f.state.projectPickup)!.withheldAssignments, []);
        assert.equal(f.effects.writes, 1);
        assert.ok(Value.Check(pickupOperationSchema, operation));
        f.client.assignProjectIssue = assign;
        f.tx.runId = 'later-scheduled-run';
        f.clock.now += 60000;
        assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
        assert.equal(operation.providerDiagnostic, undefined);
        assert.equal(f.effects.writes, 2);
      });
    }

    for (const [status, source] of [
      [408, 'structured'],
      [500, 'structured'],
      [403, 'message'],
    ] as const) {
      it(`should retain uncertain writes for ${status} from ${source} in ${runtime}`, async () => {
        const f = fixture(runtime);
        const assign = f.client.assignProjectIssue;
        const diagnostic = providerDiagnostic('github', 'api-request', 'unknown', {
          httpStatus: status,
          httpStatusSource: source,
        });
        f.client.assignProjectIssue = async (...args) => {
          await assign(...args);
          throw new GitHubWorkEventClientError(
            'github-notification-request-failed',
            'unknown outcome',
            {},
            undefined,
            diagnostic,
          );
        };
        assert.equal((await f.run({ selection: await f.select() })).status, 'attempted');
        assert.deepEqual(f.state.projectPickup!.operations[0]!.providerDiagnostic, diagnostic);
        assert.equal(pickupCapacity(f.state.records, f.state.projectPickup), 1);
        assert.equal((await f.run()).status, 'assigned');
        assert.equal(f.effects.writes, 1);
        assert.equal(f.state.projectPickup!.operations[0]!.providerDiagnostic, undefined);
      });
    }

    for (const change of ['replace', 'remove', 'add'] as const) {
      it(`should refresh ${change} guidance before accepting a pending selection in ${runtime}`, async () => {
        const f = fixture(runtime);
        f.policy.projectPickup!.selection =
          change === 'add' ? undefined : { guidance: 'prefer documentation' };
        const selection = await f.select();
        const guidance = change === 'remove' ? undefined : 'prefer release blockers';
        f.policy.projectPickup!.selection = guidance ? { guidance } : undefined;
        f.tx.runId = 'later-native-run';
        const fresh = await f.run({ selection });
        assert.equal(fresh.status, 'selection-required');
        assert.ok('digest' in fresh && 'guidance' in fresh);
        assert.notEqual(fresh.digest, selection.digest);
        assert.equal(fresh.guidance, guidance);
        assert.equal(f.effects.writes, 0);
        assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      });
    }

    it(`should refresh guidance changed during provider reads before attempting assignment in ${runtime}`, async () => {
      const f = fixture(runtime);
      const selection = await f.select();
      const history = f.client.listAssignmentEvents;
      f.client.listAssignmentEvents = async (...args) => {
        f.policy.projectPickup!.selection = { guidance: 'new priorities' };
        return history(...args);
      };
      assert.equal((await f.run({ selection })).status, 'discovering');
      assert.equal(f.effects.writes, 0);
      const fresh = await f.run();
      assert.ok('guidance' in fresh && 'digest' in fresh);
      assert.equal(fresh.guidance, 'new priorities');
      assert.notEqual(fresh.digest, selection.digest);
    });

    it(`should reconcile its assignment when a collaborator is added concurrently in ${runtime}`, async () => {
      const f = fixture(runtime);
      const write = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await write(...args);
        f.item.assignees.push({ login: 'collaborator', nodeId: 'U_collaborator', type: 'User' });
      };
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      assert.ok(f.state.projectPickup!.operations[0]!.receipt);
      assert.equal((await f.run()).status, 'assigned');
      assert.equal(f.effects.writes, 1);
    });

    it(`should replace an unused selection after a live milestone edit in ${runtime}`, async () => {
      const f = fixture(runtime);
      const before = await f.select();
      const installed = structuredClone(f.tx.enrollment);
      f.policy.projectPickup!.projects[0]!.milestone.number = 11;
      f.milestone.number = 11;
      f.milestone.nodeId = 'MI_new';
      f.item.milestone = { ...f.item.milestone!, nodeId: 'MI_new', number: 11 };
      const after = await f.select();
      assert.notEqual(after.id, before.id);
      assert.deepEqual(f.tx.enrollment, installed);
      assert.equal((await f.run({ selection: before })).status, 'failed');
      const refreshed = await f.select();
      assert.equal((await f.run({ selection: refreshed })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
      assert.equal(f.state.projectPickup!.enrollment.milestoneNodeId, 'MI_new');
      assert.equal((await f.run()).status, 'assigned');
      assert.equal(f.effects.writes, 1);
    });

    it(`should use live repository, schedule and timezone settings in ${runtime}`, async () => {
      const f = fixture(runtime);
      const first = await f.select();
      const anchor = f.state.projectPickup!.enrollment.startedAt;
      f.policy.projectPickup!.projects[0]!.repository = 'owner/another';
      f.policy.projectPickup!.schedule = normalizeSchedule('0 6 * * *');
      f.tx.timezone = 'America/New_York';
      f.client.getRepository = async () => ({
        ...f.repository,
        nodeId: 'R_another',
        name: 'another',
      });
      const selection = await f.select();
      assert.notEqual(selection.id, first.id);
      const current = f.state.projectPickup!;
      assert.equal(current.enrollment.startedAt, anchor);
      assert.equal(current.enrollment.repositoryNodeId, 'R_another');
      assert.equal(current.timezone, 'America/New_York');
      assert.equal((await f.run({ selection })).status, 'assigned');
      assert.equal(current.operations[0]!.repository, 'owner/another');
      assert.equal(f.effects.writes, 1);
    });

    it(`should preserve an attempted assignment across a live target edit in ${runtime}`, async () => {
      const f = fixture(runtime);
      await f.run({ selection: await f.select() });
      const before = structuredClone(f.state.projectPickup!.operations[0]!);
      f.policy.projectPickup!.projects[0]!.milestone.number = 11;
      f.client.getMilestone = async () => {
        throw new Error('new target unavailable');
      };
      assert.equal((await f.run()).status, 'assigned');
      assert.deepEqual(f.state.projectPickup!.operations[0], before);
      assert.equal(f.effects.writes, 1);
    });

    it(`should keep an explicitly cancelled window stopped after a live target edit in ${runtime}`, async () => {
      const f = fixture(runtime);
      await f.run({ cancel: (await f.select()).id });
      f.policy.projectPickup!.windowMinutes = 90;
      assert.equal((await f.run()).status, 'idle');
      assert.equal(f.effects.writes, 0);
    });

    for (const classification of [
      'permission',
      'unknown',
      'authentication',
      'rate-limit',
      'transport',
    ] as const) {
      it(`should ${['permission', 'unknown'].includes(classification) ? 'defer one unreadable candidate' : 'stop on a provider-wide failure'} for ${classification} in ${runtime}`, async () => {
        const f = fixture(runtime);
        const second = { ...f.item, nodeId: 'I_second', number: f.item.number + 1 };
        f.items.set(second.number, second);
        f.candidates.set(second.number, {
          ...f.candidates.get(f.item.number)!,
          nodeId: second.nodeId,
          number: second.number,
        });
        const read = f.client.getItem;
        const reads: number[] = [];
        f.client.getItem = async (...args) => {
          reads.push(args[2]);
          if (args[2] === f.item.number)
            throw new GitHubWorkEventClientError(
              'github-item-unavailable',
              'safe provider failure',
              {},
              undefined,
              providerDiagnostic('github', 'api-request', classification, {
                httpStatus: classification === 'unknown' ? 404 : 403,
              }),
            );
          return read(...args);
        };
        if (['permission', 'unknown'].includes(classification)) {
          const result = await f.run();
          assert.equal(result.status, 'selection-required');
          const op = f.state.projectPickup!.operations[0]!;
          assert.deepEqual(
            op.candidates.map(({ nodeId }) => nodeId),
            [second.nodeId],
          );
          assert.deepEqual(op.deferred, [
            {
              nodeId: f.item.nodeId,
              number: f.item.number,
              code: 'github-item-unavailable',
              providerDiagnostic: providerDiagnostic('github', 'api-request', classification, {
                httpStatus: classification === 'unknown' ? 404 : 403,
              }),
            },
          ]);
          assert.ok(Value.Check(pickupOperationSchema, op));
          assert.ok(reads.includes(second.number));
          assert.ok('digest' in result);
          assert.equal(
            (
              await f.run({
                selection: {
                  id: result.id!,
                  digest: result.digest!,
                  issueNodeId: second.nodeId,
                  rationale: 'verified ready candidate',
                },
              })
            ).status,
            'assigned',
          );
          assert.equal(f.effects.writes, 1);
        } else {
          const result = await f.run();
          assert.equal(result.status, 'failed');
          assert.ok(!reads.includes(second.number));
          assert.equal(f.state.projectPickup!.operations[0]!.deferred, undefined);
          assert.equal(f.effects.writes, 0);
        }
      });
    }

    it(`should retry deferred candidates after an empty scan in ${runtime}`, async () => {
      const f = fixture(runtime);
      const read = f.client.getItem;
      f.client.getItem = async () => {
        throw new GitHubWorkEventClientError(
          'github-notification-resource-missing',
          'missing item',
        );
      };
      assert.equal((await f.run()).status, 'empty');
      f.client.getItem = read;
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
    });

    it(`should continue beyond ten pages and one thousand candidates in ${runtime}`, async () => {
      const f = fixture(runtime);
      const original = structuredClone(f.item);
      f.items.clear();
      f.candidates.clear();
      for (let n = 1; n <= 1001; n++) {
        const nodeId = `I_${n}`;
        f.items.set(n, { ...original, number: n, nodeId });
        f.candidates.set(n, { number: n, nodeId, title: 'ready', body: 'ready work', labels: [] });
      }
      f.client.discoverProject = async (_owner, _name, _milestone, page) => ({
        candidates: [...f.candidates.values()].slice((page - 1) * 100, page * 100),
        ...(page < 11 ? { nextPage: page + 1 } : {}),
      });
      for (let page = 1; page <= 10; page++) assert.equal((await f.run()).status, 'discovering');
      assert.equal((await f.run()).status, 'selection-required');
      const operation = f.state.projectPickup!.operations[0]!;
      assert.equal(operation.candidates.length, 1001);
      assert.ok(Value.Check(pickupOperationSchema, operation));
      assert.equal(f.effects.writes, 0);
    });

    it(`should checkpoint within discovery and resume without rereading completed candidates in ${runtime}`, async () => {
      const f = fixture(runtime);
      const first = structuredClone(f.candidates.get(f.item.number)!);
      const second = { ...first, nodeId: 'I_second', number: first.number + 1 };
      f.items.set(second.number, { ...f.item, nodeId: second.nodeId, number: second.number });
      f.candidates.set(second.number, second);
      let time = 0;
      const reads: number[] = [];
      const read = f.client.projectCandidate;
      f.client.projectCandidate = async (...args) => {
        reads.push(args[2]);
        time += 21000;
        return read(...args);
      };
      const run = () =>
        projectPickup({
          ...f.tx,
          discoveryBudget: new DiscoveryBudget(20000, undefined, () => time),
        });
      assert.equal((await run()).status, 'discovering');
      const saved = f.state.projectPickup!.operations[0]!;
      assert.ok(Value.Check(pickupOperationSchema, saved));
      assert.deepEqual(saved.discovery!.pending, [
        { nodeId: second.nodeId, number: second.number },
      ]);
      f.state.projectPickup = structuredClone(f.state.projectPickup);
      assert.equal((await run()).status, 'selection-required');
      assert.deepEqual(reads, [first.number, second.number]);
      assert.equal(f.effects.writes, 0);
    });

    for (const reason of ['no-candidates', 'blocked', 'none-selected'] as const) {
      it(`should reconsider an empty window after ${reason} in ${runtime}`, async () => {
        const f = fixture(runtime);
        const candidate = structuredClone(f.candidates.get(f.item.number)!);
        if (reason === 'no-candidates') f.candidates.clear();
        if (reason === 'blocked') f.client.projectBlocked = async () => true;
        const empty =
          reason === 'none-selected'
            ? await f.run({ selection: { ...(await f.select()), issueNodeId: null } })
            : await f.run();
        assert.equal(empty.status, 'empty');
        const window = structuredClone(f.state.projectPickup!.operations[0]!.window);
        f.candidates.set(f.item.number, candidate);
        f.client.projectBlocked = async () => false;
        f.clock.now += 60000;
        const selection = await f.select();
        assert.equal((await f.run({ selection })).status, 'assigned');
        assert.equal(f.effects.writes, 1);
        assert.equal(f.state.projectPickup!.operations.length, 1);
        assert.deepEqual(f.state.projectPickup!.operations[0]!.window, window);
        await f.run();
        assert.equal(f.effects.writes, 1);
      });
    }

    it(`should keep cancellation and window closure effective after an empty scan in ${runtime}`, async () => {
      for (const stop of ['cancelled', 'closed'] as const) {
        const f = fixture(runtime);
        const candidate = structuredClone(f.candidates.get(f.item.number)!);
        f.candidates.clear();
        const empty = await f.run();
        if (stop === 'cancelled') await f.run({ cancel: empty.id! });
        else f.clock.now = f.state.projectPickup!.operations[0]!.window.closesAt;
        f.candidates.set(f.item.number, candidate);
        assert.equal((await f.run()).status, 'idle');
        assert.equal(f.effects.writes, 0);
      }
    });

    it(`should use a changed milestone after an empty scan in the same window in ${runtime}`, async () => {
      const f = fixture(runtime);
      const candidate = structuredClone(f.candidates.get(f.item.number)!);
      f.candidates.clear();
      assert.equal((await f.run()).status, 'empty');
      f.policy.projectPickup!.projects[0]!.milestone.number = 11;
      f.milestone.number = 11;
      f.milestone.nodeId = 'MI_new';
      const enrollment = {
        ...f.tx.enrollment,
        milestoneNodeId: 'MI_new',
        policyDigest: projectPickupPolicyDigest(f.policy),
      };
      await reconcileProjectPickup(
        f.state,
        f.tx.save,
        { enrollment, instanceId: 'instance', timezone: 'UTC', repository: 'owner/repo' },
        async () => {
          f.tx.enrollment = enrollment;
        },
      );
      f.candidates.set(f.item.number, candidate);
      f.clock.now += 60000;
      let requested: number | undefined;
      const discover = f.client.discoverProject;
      f.client.discoverProject = async (owner, name, milestone, page) => {
        requested = milestone;
        return discover(owner, name, milestone, page);
      };
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      assert.equal(requested, 11);
      assert.equal(f.effects.writes, 1);
      assert.equal(f.state.projectPickup!.operations.length, 1);
    });

    for (const nextWindow of [false, true]) {
      it(`should reconsider failed reads without manual recovery in ${runtime} with next window ${nextWindow}`, async () => {
        const f = fixture(runtime);
        const discover = f.client.discoverProject;
        f.client.discoverProject = async () => {
          throw new GitHubWorkEventClientError('network-error', 'temporary read failure');
        };
        assert.equal((await f.run()).status, 'failed');
        f.client.discoverProject = discover;
        if (nextWindow) f.clock.now += 86400000;
        f.tx.runId = `scan-${f.clock.now}`;
        const selection = await f.select();
        assert.equal(f.effects.writes, 0);
        assert.equal((await f.run({ selection })).status, 'assigned');
        assert.equal(f.effects.writes, 1);
      });
    }

    it(`should refresh an edited candidate instead of blocking later pickup in ${runtime}`, async () => {
      const f = fixture(runtime);
      const selection = await f.select();
      f.candidates.get(f.item.number)!.body += ' updated requirements';
      assert.equal((await f.run({ selection })).status, 'failed');
      const refreshed = await f.run({ selection });
      assert.equal(refreshed.status, 'selection-required');
      assert.ok('digest' in refreshed && refreshed.digest !== selection.digest);
      assert.equal(f.effects.writes, 0);
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
    });

    it(`should leave an attempted assignment held even if its phase is failed in ${runtime}`, async () => {
      const f = fixture(runtime);
      f.client.assignProjectIssue = async () => {
        f.effects.writes++;
        throw new Error('lost response');
      };
      await f.run({ selection: await f.select() });
      f.state.projectPickup!.operations[0]!.phase = 'failed';
      f.clock.now += 86400000;
      f.tx.runId = `scan-${f.clock.now}`;
      assert.equal((await f.run()).status, 'failed');
      assert.equal(f.effects.writes, 1);
    });

    it(`should reconcile an earlier assignment after a milestone change without another write in ${runtime}`, async () => {
      const f = fixture(runtime);
      const original = structuredClone(f.tx.enrollment);
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw Error('lost response');
      };
      assert.equal((await f.run({ selection: await f.select() })).status, 'attempted');
      const highWater = f.state.projectPickup!.highWater;
      f.policy.projectPickup!.projects[0]!.milestone.number = 11;
      f.policy.projectPickup!.windowMinutes = 30;
      const updated = {
        ...original,
        milestoneNodeId: 'MI_new',
        policyDigest: projectPickupPolicyDigest(f.policy),
      };
      await reconcileProjectPickup(
        f.state,
        f.tx.save,
        {
          enrollment: updated,
          instanceId: 'instance',
          timezone: 'UTC',
          repository: 'owner/repo',
        },
        async () => {
          f.tx.enrollment = updated;
        },
      );
      assert.equal(f.state.projectPickup!.highWater, highWater);
      assert.equal((await f.run()).status, 'assigned');
      assert.equal(f.effects.writes, 1);
      const authority = pickupAuthority(f.state.projectPickup)!;
      assert.equal(authority.retained!.length, 1);
      const item = await f.client.getItem('owner', 'repo', f.item.number);
      const work = await authorizeProjectAssignment({
        ...f.input,
        authority,
        client: f.client,
        item,
        event: f.events[0]!,
        now: f.clock.now,
      });
      assert.deepEqual(work!.enrollment, original);
      assert.equal(work!.pickup!.assignmentNodeId, f.events[0]!.nodeId);
    });

    it(`should cancel stale selection and use the new milestone in the same window in ${runtime}`, async () => {
      const f = fixture(runtime);
      const selection = await f.select();
      f.policy.projectPickup!.projects[0]!.milestone.number = 11;
      f.milestone.number = 11;
      f.milestone.nodeId = 'MI_new';
      const updated = {
        ...f.tx.enrollment,
        milestoneNodeId: 'MI_new',
        policyDigest: projectPickupPolicyDigest(f.policy),
      };
      await reconcileProjectPickup(
        f.state,
        f.tx.save,
        {
          enrollment: updated,
          instanceId: 'instance',
          timezone: 'UTC',
          repository: 'owner/repo',
        },
        async () => {
          f.tx.enrollment = updated;
        },
      );
      assert.equal((await f.run({ selection })).status, 'failed');
      assert.equal(f.effects.writes, 0);
      let requested: number | undefined;
      const discover = f.client.discoverProject;
      f.client.discoverProject = async (owner, name, milestone, page) => {
        requested = milestone;
        return discover(owner, name, milestone, page);
      };
      assert.equal((await f.run()).status, 'selection-required');
      assert.equal(requested, 11);
      assert.equal(f.effects.writes, 0);
    });

    it(`should honor shared routing eligibility and preserve uncertain assignments in ${runtime}`, async () => {
      const target = '11111111-1111-4111-8111-111111111111';
      const f = fixture(runtime);
      f.policy.routing = [{ 'owner/*': [target] }];
      const held = await f.run();
      assert.ok('code' in held && held.code === 'claim-route-instance-ineligible');
      f.identity.instanceId = target;
      assert.equal((await f.run()).status, 'selection-required');
      assert.equal(f.effects.writes, 0);
      const accepted = fixture(runtime);
      const write = accepted.client.assignProjectIssue;
      accepted.client.assignProjectIssue = async (...args) => {
        await write(...args);
        throw new Error('lost-response');
      };
      assert.equal(
        (await accepted.run({ selection: await accepted.select() })).status,
        'attempted',
      );
      accepted.policy.routing = [{ 'owner/*': target }];
      assert.equal((await accepted.run()).status, 'assigned');
      assert.equal(accepted.effects.writes, 1);
      assert.equal(pickupAuthority(accepted.state.projectPickup)!.receipts.length, 1);
    });
  }
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
    f.tx.runId = `scan-${f.clock.now}`;
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
    assert.equal((await f.run()).status, 'idle');
    delete f.state.records[0]!.request;
    f.state.records[0]!.result = { outcome: 'clarification-needed' };
    assert.equal(pickupCapacity(f.state.records, pickup), 0);
    f.clock.now += 86400000;
    f.tx.runId = `scan-${f.clock.now}`;
    assert.equal((await f.run()).status, 'empty');
    assert.equal(f.effects.writes, 1);
  });

  it('should not repeat a successful scan and allow later scans after intake takes custody', async () => {
    const f = fixture();
    const selection = await f.select();
    f.tx.runId = 'resumed-scan';
    await f.run({ selection });
    f.state.records.push({
      phase: 'complete',
      issueKey: pickupIssueKey(f.state.projectPickup!, f.item.nodeId),
      projectWork: f.work(),
      continuation: { phase: 'complete', scope: 'local', result: { outcome: 'done' } },
    });
    assert.equal((await f.run()).status, 'idle');
    f.clock.now += 86400000;
    f.tx.runId = `scan-${f.clock.now}`;
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
    f.policy.maxConcurrentItems = 1;
    await f.run({ selection: await f.select() });
    f.state.records.push({
      phase: 'complete',
      retired: {},
      projectWork: f.work(),
      request: {},
      issueKey: pickupIssueKey(f.state.projectPickup!, f.item.nodeId),
    });
    f.clock.now += 86400000;
    f.tx.runId = `scan-${f.clock.now}`;
    assert.equal((await f.run()).status, 'at-capacity');
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
    assert.equal(pickupCapacity(f.state.records, f.state.projectPickup), 1);
  });
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should bound expired unattempted cancellations and preserve the current stop in ${runtime}`, async () => {
      const f = fixture(runtime);
      const first = (await f.select()).id;
      for (let day = 0; day < 40; day++) {
        const selection = await f.select();
        await f.run({ cancel: selection.id });
        assert.equal((await f.run()).status, 'idle');
        f.clock.now += 86400000;
        f.tx.runId = `scan-${f.clock.now}`;
      }
      const current = await f.select();
      assert.equal(f.state.projectPickup!.operations.length, 32);
      assert.ok(!f.state.projectPickup!.operations.some((entry) => entry.id === first));
      await f.run({ cancel: current.id });
      assert.equal((await f.run()).status, 'idle');
      assert.equal(f.effects.writes, 0);
    });

    for (const uncertain of [false, true]) {
      it(`should retain cancellation evidence with uncertain write ${uncertain} when history is pruned in ${runtime}`, async () => {
        const f = fixture(runtime);
        if (uncertain)
          f.client.assignProjectIssue = async () => {
            f.effects.writes++;
            throw new Error('response lost');
          };
        const selection = await f.select();
        await f.run({ selection });
        await f.run({ cancel: selection.id });
        for (let day = 0; day < 40; day++) {
          f.clock.now += 86400000;
          f.tx.runId = `scan-${f.clock.now}`;
          await f.run();
        }
        assert.deepEqual(pickupAuthority(f.state.projectPickup)!.withheldAssignments, [
          {
            issueNodeId: f.item.nodeId,
            ...(uncertain ? {} : { assignmentNodeId: f.events[0]!.nodeId }),
          },
        ]);
        assert.equal(f.effects.writes, 1);
      });
    }
  }
});
