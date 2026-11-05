import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import issuePickup, {
  pickupAuthority,
  pickupSelectionInstructions,
} from '../agent/issue-pickup.ts';
import { pickupOperationSchema } from '../agent/issue-pickup-state.ts';
import pickupCapacity, { pickupIssueKey } from '../agent/issue-pickup-capacity.ts';
import DiscoveryBudget from '../agent/discovery-budget.ts';
import reconcileIssuePickup from '../agent/issue-pickup-reconcile.ts';
import { issuePickupPolicyDigest } from '../agent/issue-pickup-authority.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import fixture from './issue-pickup-selection-fixture.ts';

describe('agent/issue-pickup', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    for (const guidance of [undefined, 'prefer urgent work']) {
      it(`should report the effective comparison guidance without retaining it in ${runtime} with custom guidance ${guidance !== undefined}`, async () => {
        const f = fixture(runtime);
        f.policy.issuePickup!.selection = guidance === undefined ? undefined : { guidance };
        const selection = await f.select();
        const result = await f.run({ selection: { ...selection, issueNodeId: null } });
        assert.ok('selectionGuidance' in result && result.selectionGuidance);
        assert.deepEqual(result.selectionGuidance, {
          source: guidance === undefined ? 'built-in' : 'inline',
          content: [pickupSelectionInstructions, guidance].filter(Boolean).join('\n\n'),
        });
        assert.deepEqual(f.state.projectPickup!.operations, []);
        const next = await f.run();
        assert.equal('selectionGuidance' in next, false);
      });
    }
    it(`should pass complete candidates and guidance to the model without selecting in ${runtime}`, async () => {
      const f = fixture(runtime);
      const result = await f.run();
      assert.equal(result.status, 'selection-required');
      assert.ok('candidates' in result && result.candidates?.[0]?.body);
      assert.ok('guidance' in result && result.guidance);
      assert.equal(f.effects.writes, 0);
    });

    it(`should read discovery eligibility and content together in ${runtime}`, async () => {
      const f = fixture(runtime);
      const getItem = f.client.getItem;
      f.client.getItem = async () => {
        throw new Error('discovery must use the combined candidate read');
      };
      const selection = await f.select();
      f.client.getItem = getItem;
      f.item.assignees = [f.client.identity];
      assert.equal((await f.run({ selection })).status, 'failed');
      assert.equal(f.effects.writes, 0);
    });

    it(`should discard prior scan material and load current guidance in ${runtime}`, async () => {
      const f = fixture(runtime);
      const old = await f.select();
      f.policy.issuePickup!.selection = { guidance: 'new priorities' };
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

    for (const reason of ['missing', 'permission', 'malformed']) {
      it(`should keep readable candidates when dependency metadata is ${reason} in ${runtime}`, async () => {
        const f = fixture(runtime);
        const diagnostic = providerDiagnostic('github', 'api-request', 'permission', {
          httpStatus: 403,
          providerMessage: 'Dependency metadata unavailable',
        });
        f.client.projectBlocked = async () => {
          if (reason === 'malformed') throw new Error('issue-pickup-dependencies-invalid');
          throw new GitHubWorkEventClientError(
            reason === 'missing'
              ? 'github-notification-resource-missing'
              : 'github-notification-request-failed',
            'dependency read failed',
            {},
            undefined,
            reason === 'permission' ? diagnostic : undefined,
          );
        };
        const result = await f.run();
        assert.equal(result.status, 'selection-required');
        assert.ok('candidates' in result && result.candidates?.length === 1);
        const candidate = result.candidates[0]!;
        assert.equal(candidate.blockedByOpenIssues, undefined);
        assert.ok(candidate.dependencyError);
        if (reason === 'permission')
          assert.deepEqual(candidate.dependencyError.providerDiagnostic, diagnostic);
        const selection = await f.select();
        assert.equal((await f.run({ selection })).status, 'assigned');
        assert.equal(f.effects.writes, 1);
      });
    }

    it(`should preserve account and transport failures during dependency reads in ${runtime}`, async () => {
      for (const classification of ['authentication', 'rate-limit', 'transport'] as const) {
        const f = fixture(runtime);
        const diagnostic = providerDiagnostic('github', 'api-request', classification);
        f.client.projectBlocked = async () => {
          throw new GitHubWorkEventClientError(
            'github-notification-request-failed',
            'dependency read failed',
            {},
            undefined,
            diagnostic,
          );
        };
        const result = await f.run();
        assert.equal(result.status, 'failed');
        assert.ok('providerDiagnostic' in result);
        assert.deepEqual(result.providerDiagnostic, diagnostic);
        assert.equal(f.effects.writes, 0);
      }
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
      assert.equal(f.state.projectPickup!.charges?.length, 1);
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
      assert.equal(f.state.projectPickup!.charges?.length, 1);
    });

    it(`should preserve the used allowance across live target changes in ${runtime}`, async () => {
      const f = fixture(runtime);
      await f.run({ selection: await f.select() });
      f.policy.issuePickup!.projects[0]!.milestone.number = 11;
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
      f.policy.issuePickup!.projects[0]!.milestone.number = 11;
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
        assert.equal(pickupCapacity(f.state.projectPickup), 0);
        assert.deepEqual(pickupAuthority(f.state.projectPickup)!.withheldAssignments, []);
        assert.equal(f.state.projectPickup!.charges?.length, 0);
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
        assert.equal(pickupCapacity(f.state.projectPickup), 1);
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
      f.policy.issuePickup!.projects[0]!.milestone.number = 11;
      const enrollment = {
        ...old,
        milestoneNodeId: 'M_next',
        policyDigest: issuePickupPolicyDigest(f.policy),
      };
      await reconcileIssuePickup(f.state, f.tx.save, { enrollment, timezone: 'UTC' }, async () => {
        f.tx.enrollment = enrollment;
      });
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
      const read = f.client.projectCandidate;
      f.client.projectCandidate = async () => {
        throw new GitHubWorkEventClientError('github-notification-resource-missing', 'missing');
      };
      const result = await f.run();
      assert.equal(result.status, 'empty');
      assert.ok('summary' in result && result.summary?.skipped === 1);
      f.client.projectCandidate = async () => {
        throw new GitHubWorkEventClientError(
          'github-notification-request-failed',
          'account unavailable',
        );
      };
      assert.equal((await f.run()).status, 'failed');
      f.client.projectCandidate = read;
      assert.equal((await f.run({ selection: await f.select() })).status, 'assigned');
    });
  }

  it('should enforce independent 3, 1, 1 limits and assign at most once per scan', async () => {
    const f = fixture();
    const alpha = f.addRepository('alpha', 4);
    const beta = f.addRepository('beta', 2);
    const gamma = f.addRepository('gamma', 2);
    f.policy.issuePickup!.projects = [alpha, beta, gamma].map((project, index) => ({
      repository: `owner/${project.repository.name}`,
      milestone: { number: project.milestone.number, policy: 'only' },
      limit: index === 0 ? 3 : 1,
    }));

    for (let scan = 0; scan < 5; scan++) {
      f.tx.runId = `scan-${scan}`;
      const options = await f.run();
      assert.equal(options.status, 'selection-required');
      if (!('candidates' in options) || !options.candidates) assert.fail('expected candidates');
      if (scan === 0) {
        const sameNumber = options.candidates.filter((item) => item.number === f.item.number);
        assert.deepEqual(
          sameNumber.map((item) => item.repository),
          ['owner/alpha', 'owner/beta', 'owner/gamma'],
        );
      }
      if (scan >= 3)
        assert.ok(options.candidates.every((item) => item.repository !== 'owner/alpha'));
      const result = await f.run({
        selection: {
          id: options.id,
          digest: options.digest,
          issueNodeId: options.candidates[0]!.nodeId,
          rationale: 'ready to pick up',
        },
      });
      assert.equal(result.status, 'assigned');
      assert.equal(f.effects.writes, scan + 1);
      if (scan < 4) assert.equal((await f.run()).status, 'scan-complete');
    }
    f.tx.runId = 'exhausted';
    const result = await f.run();
    assert.equal(result.status, 'allowance-reached');
    assert.deepEqual(
      result.allowances?.map(({ used, limit }) => [used, limit]),
      [
        [3, 3],
        [1, 1],
        [1, 1],
      ],
    );
    assert.deepEqual(
      [alpha, beta, gamma].map(
        (project) => [...project.items.values()].filter((issue) => issue.assignees.length).length,
      ),
      [3, 1, 1],
    );
  });

  it('should exclude a repository with an unreadable milestone page and keep other candidates', async () => {
    const f = fixture();
    f.addRepository('other');
    f.policy.issuePickup!.projects.push({
      repository: 'owner/other',
      milestone: { number: 10, policy: 'only' },
      limit: 1,
    });
    const discover = f.client.discoverProject;
    f.client.discoverProject = async (owner, name, milestone, page) => {
      if (name === 'repo')
        throw new GitHubWorkEventClientError('github-notification-resource-missing', 'missing');
      return discover(owner, name, milestone, page);
    };
    const options = await f.run();
    assert.equal(options.status, 'selection-required');
    if (!('candidates' in options) || !options.candidates) assert.fail('expected candidates');
    assert.deepEqual(
      options.candidates.map((item) => item.repository),
      ['owner/other'],
    );
    const result = await f.run({
      selection: {
        id: options.id,
        digest: options.digest,
        issueNodeId: options.candidates[0]!.nodeId,
        rationale: 'ready',
      },
    });
    assert.equal(result.status, 'assigned');
    assert.equal(result.allowances?.[0]?.code, 'issue-pickup-repository-unavailable');
  });

  it('should recheck a lowered repository limit before writing a prepared selection', async () => {
    const f = fixture();
    const other = f.addRepository('other', 2);
    const project = {
      repository: 'owner/other',
      milestone: { number: 10, policy: 'only' as const },
      limit: 2,
    };
    f.policy.issuePickup!.projects.push(project);
    const first = await f.select();
    assert.equal(
      (
        await f.run({
          selection: { ...first, issueNodeId: other.items.get(f.item.number)!.nodeId },
        })
      ).status,
      'assigned',
    );

    f.tx.runId = 'second-scan';
    const second = await f.select();
    const read = f.client.getItem;
    f.client.getItem = async (...args) => {
      project.limit = 1;
      return read(...args);
    };
    const result = await f.run({
      selection: { ...second, issueNodeId: other.items.get(f.item.number + 1)!.nodeId },
    });
    assert.equal(result.status, 'pending');
    assert.equal(result.code, 'issue-pickup-repository-limit-reached');
    assert.equal(f.effects.writes, 1);
  });

  it('should preserve an unattributable legacy assignment fence through the open window', async () => {
    const f = fixture();
    await f.run();
    const state = f.state.projectPickup!;
    state.windowAssignment = { window: state.operations[0]!.window, assignedAt: f.clock.now };
    state.operations = [];
    f.policy.issuePickup!.projects[0]!.limit = 3;
    assert.equal((await f.run()).status, 'allowance-reached');
    assert.equal(f.effects.writes, 0);
    f.clock.now += 86_400_000;
    f.tx.runId = 'tomorrow';
    assert.equal((await f.run()).status, 'selection-required');
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
      assert.ok('code' in result && result.code === 'issue-pickup-assignment-unverified');
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

  it('should leave confirmed assignment capacity to ordinary intake', async () => {
    const f = fixture();
    await f.run({ selection: await f.select() });
    const pickup = f.state.projectPickup!;
    assert.equal(pickupCapacity(pickup), 0);
    assert.equal(pickupCapacity(pickup, f.item.nodeId), 0);
    f.state.records.push({
      projectWork: f.work(),
      phase: 'assessing',
      issueKey: pickupIssueKey(pickup, f.item.nodeId),
      request: {},
    });
    assert.equal(pickupCapacity(pickup), 0);
    assert.equal((await f.run()).status, 'allowance-reached');
    delete f.state.records[0]!.request;
    f.state.records[0]!.result = { outcome: 'clarification-needed' };
    assert.equal(pickupCapacity(pickup), 0);
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
      issuePickup({
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
    assert.equal(pickupCapacity(f.state.projectPickup), 0);
    assert.equal(
      pickupAuthority(f.state.projectPickup)!.retained![0]!.assignmentNodeId,
      f.events[0]!.nodeId,
    );
  });
});
