import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';

import issueLaunch from '../agent/issue-launch.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import type { AssessmentEntryDependencies } from '../agent/assessment-entry.ts';
import { inspectAdmittedIssue, inspectContinuedIssue } from '../agent/dispatch-assignment.ts';
import { dispatchAdmission } from '../agent/managed-issue.ts';
import assessmentOwner from '../agent/assessment-owner.ts';
import pendingDispatchAssignments from '../agent/dispatch-pending.ts';
import { baseline, intakeFixture, fixturePullRequest } from './github-intake-fixture.ts';
import managedOwner from '../agent/managed-owner.ts';
import type { LaunchRequest } from '../tools/dispatch/launch-schema.ts';

describe('agent/issue-launch', () => {
  let root: string;
  let fixture: ReturnType<typeof intakeFixture>;
  let context: AssessmentEntryDependencies;
  let journal: OpenClawDispatchStore;
  beforeEach(async () => {
    root = await mkdtemp('/tmp/issue-launch-');
    fixture = intakeFixture();
    journal = new OpenClawDispatchStore(root, 'a'.repeat(64));
    context = {
      operator: true,
      root,
      binding: {
        runtime: 'openclaw',
        agentId: 'receiver',
        workspace: root,
        namespace: root,
        session: 'operator-chat',
        incarnation: 'session-id',
      },
      turnId: 'operator-turn',
      inputId: 'operator-input',
      now: baseline,
      manifest: { schemaVersion: 1, agent: { id: 'receiver' } },
      git: async (_cwd, argv) => {
        assert.equal(argv[0], 'check-ref-format');
        if (argv[1] === 'refs/heads/unsafe/../branch') throw new Error('fixture-ref-invalid');
        return '';
      },
      resolveSkill: async () => {
        throw new Error('unexpected skill resolution');
      },
      managed: async () => undefined,
      connectProvider: async () => client(),
      assertCurrent: async () => {},
    };
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const client = () => ({
    ...fixture.client,
    async getItemContext() {
      return {
        title: 'Repair issue',
        body: 'Retain the outcome.',
        comments: [],
        labels: [],
        truncated: false,
      };
    },
  });
  const launch = (target = 'owner/repo#3', options: Partial<LaunchRequest> = {}) =>
    issueLaunch({
      action: { action: 'launch', operation: 'context', target, ...options },
      context,
      journal,
      scope: journal.scope,
      client: client(),
      create: (record) => record,
      verifyExisting: async () => {},
    });

  it('should retain an unassigned draft pr, refresh its unsubmitted head and reuse its native destination', async () => {
    const pr = fixturePullRequest(fixture);
    fixture.client.listAssignmentEvents = async () => {
      throw new Error('no assignment effects');
    };
    const target = 'https://github.com/owner/repo/pull/3';
    const first = await launch(target);
    assert.ok('digest' in first);
    pr.headSha = '2'.repeat(40);
    const second = await launch(target);
    assert.ok('digest' in second);
    assert.equal(second.id, first.id);
    assert.notEqual(second.digest, first.digest);
    await journal.exclusive(async (state, save) => {
      const record = state.records[0]!;
      assert.equal(record.manualIssue?.pullRequest?.headSha, pr.headSha);
      assert.equal(record.manualIssue?.pullRequest?.authorId, 'U_operator');
      record.threadId = 'pr-chat';
      await save();
    });
    pr.headSha = '3'.repeat(40);
    assert.equal((await launch(target)).status, 'existing');
    const records = (await journal.read()).records;
    assert.equal(records.length, 1);
    await assert.rejects(
      inspectAdmittedIssue(records[0]!.manualIssue!, fixture.client),
      /head-changed/,
    );
    await inspectContinuedIssue(records[0]!.manualIssue!, fixture.client, [], records[0]);
    pr.headRef = 'replacement-branch';
    await assert.rejects(launch(target), /binding-changed/);
  });

  it('should reject invalid pr destinations before reserving any work', async () => {
    const pr = fixturePullRequest(fixture);
    const target = 'https://github.com/owner/repo/pull/3';
    for (const mutate of [
      () => {
        pr.headRepositoryNodeId = 'R_fork';
      },
      () => {
        pr.headRef = 'unsafe/../branch';
      },
      () => {
        pr.merged = true;
      },
    ]) {
      const before = structuredClone(pr);
      mutate();
      await assert.rejects(launch(target));
      Object.assign(pr, before);
    }
    assert.equal((await journal.read()).records.length, 0);
  });

  for (const runtime of ['openclaw', 'codex'] as const)
    it(`should select the exact existing pr for ${runtime} without creating a publication receipt`, async () => {
      context.binding.runtime = runtime;
      context.git = async (_cwd, argv) => {
        assert.equal(argv[0], 'check-ref-format');
        return '';
      };
      context.connectDelivery = async () => ({
        git: async () => '',
        account: {
          identity: fixture.client.identity,
          execute: async (argv) => ({
            exitCode: 0,
            stderr: '',
            timedOut: false,
            truncated: false,
            stdout:
              'HTTP/2 200 OK\n\n' +
              JSON.stringify(
                argv.some((arg) => arg.includes('/pulls/'))
                  ? {
                      nodeId: 'PR_7',
                      number: 7,
                      state: 'open',
                      repositoryId: 'R_repo',
                      headRepositoryId: 'R_repo',
                      head: 'a'.repeat(40),
                      branch: 'existing-work',
                      base: 'release',
                      authorId: 'U_collaborator',
                      title: 'Existing work',
                      body: '',
                    }
                  : { databaseId: 20, nodeId: 'I_issue', number: 3, title: 'Issue' },
              ),
          }),
        },
      });
      const first = await launch(undefined, {
        pullRequest: 'https://github.com/owner/repo/pull/7',
      });
      assert.equal(first.status, 'routing-required');
      const record = (await journal.read()).records[0]!;
      assert.equal(record.adoptedPullRequest?.head, 'a'.repeat(40));
      assert.equal(record.work?.delivery, undefined);
      assert.equal(record.threadId, undefined);
      const again = await launch(undefined, {
        pullRequest: 'https://github.com/owner/repo/pull/7',
      });
      assert.ok('id' in first && 'id' in again && first.id === again.id);
      assert.equal((await journal.read()).records.length, 1);
    });

  it('should create an explicitly additional task once while ordinary launch reuses the primary', async () => {
    const primary = await launch();
    assert.ok('id' in primary);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.threadId = 'primary-chat';
      await save();
    });
    const fresh = await launch(undefined, { fresh: true });
    assert.ok('id' in fresh);
    assert.notEqual(fresh.id, primary.id);
    assert.equal(fresh.status, 'routing-required');
    const retry = await launch(undefined, { fresh: true });
    assert.ok('id' in retry);
    assert.equal(retry.id, fresh.id);
    const reused = await launch();
    assert.ok('id' in reused);
    assert.equal(reused.id, primary.id);
    await journal.exclusive(async (state, save) => {
      state.records[1]!.threadId = 'additional-chat';
      await save();
    });
    const state = await journal.read();
    assert.equal(state.records.length, 2);
    assert.equal(state.records[1]!.manualIssue?.fresh, true);
    for (const record of state.records)
      assert.equal(managedOwner(state.records, record.threadId!, () => true).owner?.id, record.id);
    assert.equal(managedOwner(state.records, 'operator-chat', () => true).owner?.id, primary.id);
    const conflicting = structuredClone(state.records[0]!);
    conflicting.id = 'f'.repeat(64);
    conflicting.threadId = 'unexpected-owner';
    assert.equal(
      managedOwner([...state.records, conflicting], 'primary-chat', () => true).status,
      'ambiguous',
    );
    context.inputId = 'another-explicit-launch';
    const another = await launch(undefined, { fresh: true });
    assert.ok('id' in another);
    assert.notEqual(another.id, fresh.id);
    assert.equal((await journal.read()).records.length, 3);
  });

  it('should allow explicit fresh work beside preserved history without reviving that history', async () => {
    await launch();
    await journal.exclusive(async (state, save) => {
      state.records[0]!.retired = { at: baseline, by: 'operator' };
      await save();
    });
    const next = await launch(undefined, { fresh: true });
    assert.equal(next.status, 'routing-required');
    assert.equal((await journal.read()).records[0]!.retired?.by, 'operator');
  });

  it('should refresh unconsumed routing instructions in the same manual owner', async () => {
    context.manifest.models = {
      default: { model: 'openai/example', effort: 'high' },
      routing: { guidance: 'First instructions.' },
    };
    const first = await launch();
    assert.ok('digest' in first);
    context.manifest.models.routing = { guidance: 'Changed instructions.' };
    const second = await launch();
    assert.ok('digest' in second);
    assert.equal(first.id, second.id);
    assert.notEqual(first.digest, second.digest);
    const records = (await journal.read()).records;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.routingInstructions?.guidance?.content, 'Changed instructions.');
  });

  it('should reserve unassigned work once without creating an assignment receipt', async () => {
    fixture.item.assignees = [];
    fixture.client.listAssignmentEvents = async () => {
      throw new Error('manual launch must not read assignment history');
    };
    const first = await launch();
    const second = await launch();
    assert.equal(first.status, 'routing-required');
    assert.deepEqual(second, first);
    const state = await journal.read();
    assert.equal(state.records.length, 1);
    const record = state.records[0]!;
    assert.equal(record.intakeId, undefined);
    assert.equal(record.manualIssue?.initiation.input, 'operator-input');
    assert.equal('assignment' in record.manualIssue!, false);
    assert.equal(state.run, undefined);
    const manual = record.manualIssue!;
    const assignment = {
      version: 1 as const,
      id: 'assignment-receipt',
      scope: manual.scope,
      receiving: manual.receiving,
      workspaceDir: root,
      agentId: 'receiver',
      host: 'github.com' as const,
      repository: manual.repository,
      issue: manual.issue,
      assignment: {
        ...fixture.events[0]!,
        event: 'assigned' as const,
        actor: { ...fixture.events[0]!.actor, type: 'User' },
        assignee: { ...fixture.events[0]!.assignee, type: 'User' },
      },
      evidence: {
        policyDigest: 'policy',
        mode: 'plan' as const,
        open: true as const,
        assigned: true as const,
        repositoryReadable: true as const,
        ownerPinned: true as const,
        actorPinned: true as const,
      },
      observedAt: baseline,
      admittedAt: baseline,
      status: 'admitted' as const,
      requiresRevalidation: true as const,
    };
    assert.deepEqual(pendingDispatchAssignments(state, { records: [assignment] }), []);
    const automatic = {
      ...record,
      id: 'b'.repeat(64),
      intakeId: assignment.id,
      manualIssue: undefined,
    };
    const additional = {
      ...record,
      id: 'c'.repeat(64),
      manualIssue: { ...manual, id: 'c'.repeat(64), fresh: true as const },
    };
    assert.deepEqual(
      pendingDispatchAssignments({ records: [automatic, additional] }, { records: [assignment] }),
      [{ intake: assignment, record: automatic }],
    );
    assert.deepEqual(
      pendingDispatchAssignments({ records: [additional] }, { records: [assignment] }),
      [],
    );

    const admission = dispatchAdmission(record, [])!;
    await inspectAdmittedIssue(admission, fixture.client);
    await inspectContinuedIssue(admission, fixture.client, [], record);
    assert.equal(record.assignmentObservation, undefined);
    assert.deepEqual(fixture.item.assignees, []);
  });

  it('should retain operator-origin custody and return its existing issue destination', async () => {
    await launch();
    await journal.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.threadId = 'issue-chat';
      record.worktree = root;
      await save();
    });
    const existing = await launch();
    assert.equal(existing.status, 'existing');
    assert.ok('destination' in existing && existing.destination === 'issue-chat');
    await assert.rejects(launch('owner/repo#4'), /identity-mismatch/);
    const state = await journal.read();
    // incomplete managed custody must not masquerade as an ordinary, unowned chat.
    assert.throws(
      () =>
        assessmentOwner(state.records, [], 'issue-chat', { repository: 'owner/repo', number: 3 }),
      /context-invalid/,
    );
  });

  it('should reuse current work beside retired history and refuse the retired caller', async () => {
    await launch();
    await journal.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.threadId = 'current-chat';
      const previous = structuredClone(record);
      previous.id = 'b'.repeat(64);
      previous.manualIssue!.id = previous.id;
      previous.threadId = 'old-chat';
      previous.retired = { at: baseline, by: 'operator' };
      state.records.unshift(previous);
      await save();
    });
    const before = await journal.read();
    const result = await launch();
    assert.ok('destination' in result && result.destination === 'current-chat');
    context.binding.session = 'old-chat';
    await assert.rejects(launch(), /launch-owner-inactive/);
    assert.deepEqual(await journal.read(), before);
  });

  it('should retain historical-only attempts without creating a replacement', async () => {
    await launch();
    await journal.exclusive(async (state, save) => {
      state.records[0]!.retired = { at: baseline, by: 'operator' };
      await save();
    });
    const before = await journal.read();
    await assert.rejects(launch(), /launch-owner-inactive/);
    await assert.rejects(launch(undefined, { id: before.records[0]!.id }), /launch-owner-inactive/);
    assert.deepEqual(await journal.read(), before);
  });

  it('should reject unauthorized or closed work before reservation', async () => {
    context.operator = false;
    await assert.rejects(launch(), /operator-required/);
    context.operator = true;
    fixture.item.state = 'closed';
    await assert.rejects(launch(), /open-issue-required/);
    assert.equal((await journal.read()).records.length, 0);
  });

  it('should preserve live operator direction and refuse inactive owner recreation', async () => {
    context.assertCurrent = async () => {
      throw new Error('native-input-changed');
    };
    await assert.rejects(launch(), /native-input-changed/);
    context.assertCurrent = async () => {};
    await launch();
    await journal.exclusive(async (state, save) => {
      state.records[0]!.nativeInactive = true;
      await save();
    });
    await assert.rejects(launch(), /owner-inactive/);
    assert.equal((await journal.read()).records.length, 1);
  });
  it('should distinguish decoded assigner defaults from explicit recipient requirements', async () => {
    const assignment = {
      paused: false,
      allowed: [],
      mode: 'plan' as const,
      pullRequest: {
        defaultAssignmentActor: true,
        recipients: [{ source: 'assignment-actor' as const, roles: ['assignee' as const] }],
      },
    };
    context.manifest.github = {
      notifications: {
        schemaVersion: 3,
        runtimes: ['openclaw'],
        intervalMinutes: 5,
        maxConcurrentItems: 1,
        allowedRepositoryOwners: [],
        issueAssignment: assignment,
      },
    };
    assert.equal((await launch()).status, 'routing-required');
    assignment.pullRequest.defaultAssignmentActor = false;
    await assert.rejects(launch(), /assignment-actor-recipient-unavailable/);
    assert.equal((await journal.read()).records.length, 1);
  });
  it('should reject conflicting or moved operator origin without changing the saved owner', async () => {
    await launch();
    const before = await journal.read();
    await assert.rejects(
      journal.exclusive(async (state, save) => {
        state.records[0]!.intakeId = 'e'.repeat(64);
        await save();
      }),
      /dispatch-state-invalid/,
    );
    await assert.rejects(
      journal.exclusive(async (state, save) => {
        state.records[0]!.manualIssue!.initiation.session = 'another-origin';
        await save();
      }),
      /dispatch-state-invalid/,
    );
    assert.deepEqual(await journal.read(), before);
  });
});
