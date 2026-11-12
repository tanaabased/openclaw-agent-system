import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import IntakeRecordStore, {
  type IntakeObservation,
} from '../channels/github/intake/record-store.ts';

import type { AssessmentEntryDependencies } from '../agent/tasks/assessment/assessment-entry.ts';
import assessmentOwner from '../agent/tasks/assessment/assessment-owner.ts';
import {
  inspectAdmittedIssue,
  inspectContinuedIssue,
} from '../agent/tasks/dispatch/dispatch-assignment.ts';
import pendingDispatchAssignments from '../agent/tasks/dispatch/dispatch-pending.ts';
import issueLaunch from '../agent/tasks/dispatch/issue-launch.ts';
import { dispatchAdmission } from '../agent/tasks/managed-issue.ts';
import managedOwner from '../agent/tasks/managed-owner.ts';
import OpenClawDispatchStore from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import type { LaunchRequest } from '../tools/dispatch/launch-schema.ts';
import { baseline, fixturePullRequest, intakeFixture } from './github-intake-fixture.ts';

describe('agent/issue-launch', () => {
  let root: string;
  let fixture: ReturnType<typeof intakeFixture>;
  let context: AssessmentEntryDependencies;
  let journal: OpenClawDispatchStore;
  let store: IntakeRecordStore;
  let claim: ((event: IntakeObservation, id: string) => Promise<unknown>) | undefined;
  beforeEach(async () => {
    root = await mkdtemp('/tmp/issue-launch-');
    fixture = intakeFixture();
    journal = new OpenClawDispatchStore(root, 'a'.repeat(64));
    store = new IntakeRecordStore({ root, scope: journal.scope, path: root + '/intake.json' });
    claim = undefined;
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
      intakeStore: store,
      claim,
      client: client(),
      create: (record) => record,
      verifyExisting: async () => {},
    });

  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should resolve ${runtime} launch attempts from native custody without copied selectors`, async () => {
      context.binding.runtime = runtime;
      await launch();
      const extra = await launch(undefined, { fresh: true });
      assert.ok('id' in extra && 'digest' in extra);
      for (const override of [{ id: extra.id }, { digest: extra.digest }])
        await assert.rejects(
          launch(undefined, override as Partial<LaunchRequest>),
          /launch-request-invalid/,
        );
      context.inputId = 'resumed-input';
      const resumed = await launch(undefined, { operation: 'prepare', fresh: true });
      assert.ok('id' in resumed);
      assert.equal(resumed.id, extra.id);
      await launch(undefined, { fresh: true });
      context.inputId = 'ambiguous-followup';
      const before = await journal.read();
      await assert.rejects(
        launch(undefined, { operation: 'prepare', fresh: true }),
        /launch-owner-ambiguous/,
      );
      assert.deepEqual(await journal.read(), before);
    });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should assign and consume one ${runtime} event before setup, retaining other assignees`, async () => {
      context.binding.runtime = runtime;
      const other = { login: 'other', nodeId: 'U_other', type: 'User' };
      fixture.item.assignees = [other];
      let assignments = 0;
      fixture.client.assignProjectIssue = async () => {
        assert.equal((await journal.read()).records.length, 1);
        assignments++;
        fixture.item.assignees.push(fixture.client.identity);
      };
      const first = await launch();
      assert.ok('id' in first);
      assert.equal(assignments, 1);
      assert.deepEqual(fixture.item.assignees, [other, fixture.client.identity]);
      assert.equal((await store.read())?.observedAssignments?.[0]?.consumedBy, first.id);
      assert.equal((await store.read())?.manualOnly, true);
      await launch(undefined, { operation: 'prepare' });
      assert.equal(assignments, 1);
      context.inputId = 'second-manual-input';
      const second = await launch();
      assert.ok('id' in second && second.id !== first.id);
      assert.equal((await store.read())?.observedAssignments?.[0]?.consumedBy, first.id);
    });

    it(`should continue ${runtime} manual launch after assignment denial without retrying the write`, async () => {
      context.binding.runtime = runtime;
      fixture.item.assignees = [];
      let attempts = 0;
      fixture.client.assignProjectIssue = async () => {
        attempts++;
        throw new Error('github-permission-denied');
      };
      const first = await launch();
      assert.equal(first.status, 'routing-required');
      assert.ok('notice' in first && first.notice?.code === 'github-permission-denied');
      await launch();
      assert.equal(attempts, 1);
      assert.equal(await store.read(), undefined);
    });

    it(`should reconcile a lost ${runtime} assignment response without repeating assignment`, async () => {
      context.binding.runtime = runtime;
      fixture.item.assignees = [];
      let attempts = 0;
      fixture.client.assignProjectIssue = async () => {
        attempts++;
        fixture.item.assignees = [fixture.client.identity];
        throw new Error('response-lost');
      };
      await launch();
      await launch();
      assert.equal(attempts, 1);
      assert.ok((await store.read())?.observedAssignments?.[0]?.consumedBy);
    });

    it(`should use configured ${runtime} claims without making placement a launch gate`, async () => {
      context.binding.runtime = runtime;
      context.manifest.github = {
        notifications: {
          ...fixture.policy,
          routing: [{ 'owner/*': ['11111111-1111-1111-1111-111111111111'] }],
        },
      };
      let calls = 0;
      claim = async (event) => {
        calls++;
        assert.equal(event.assignment.nodeId, fixture.events[0]!.nodeId);
        return { status: 'handled', winnerId: 7 };
      };
      assert.equal((await launch()).status, 'routing-required');
      assert.equal(calls, 1);
      context.inputId = 'another-manual-launch';
      claim = async () => {
        throw new Error('claim-publication-unconfirmed');
      };
      assert.equal((await launch()).status, 'routing-required');
      assert.equal((await journal.read()).records.length, 2);
    });
  }

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
      assert.equal(record.delivery, undefined);
      assert.equal(record.threadId, undefined);
      const again = await launch(undefined, {
        pullRequest: 'https://github.com/owner/repo/pull/7',
      });
      assert.ok('id' in first && 'id' in again && first.id === again.id);
      assert.equal((await journal.read()).records.length, 1);
    });

  it('should create independent tasks for distinct operator inputs and recover the exact request', async () => {
    const primary = await launch();
    assert.ok('id' in primary);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.threadId = 'primary-chat';
      await save();
    });
    context.inputId = 'second-operator-input';
    const fresh = await launch();
    assert.ok('id' in fresh);
    assert.notEqual(fresh.id, primary.id);
    assert.equal(fresh.status, 'routing-required');
    const retry = await launch(undefined, { fresh: true });
    assert.ok('id' in retry);
    assert.equal(retry.id, fresh.id);
    const reused = await launch();
    assert.ok('id' in reused);
    assert.equal(reused.id, fresh.id);
    await journal.exclusive(async (state, save) => {
      state.records[1]!.threadId = 'additional-chat';
      await save();
    });
    const state = await journal.read();
    assert.equal(state.records.length, 2);
    assert.equal(state.records[1]!.manualIssue?.fresh, true);
    for (const record of state.records)
      assert.equal(managedOwner(state.records, record.threadId!, () => true).owner?.id, record.id);
    assert.equal(managedOwner(state.records, 'operator-chat', () => true).status, 'ambiguous');
    const conflicting = structuredClone(state.records[0]!);
    conflicting.id = 'f'.repeat(64);
    conflicting.threadId = 'unexpected-owner';
    assert.equal(
      managedOwner([...state.records, conflicting], 'primary-chat', () => true).owner?.id,
      primary.id,
    );
    context.inputId = 'another-explicit-launch';
    const another = await launch(undefined, { fresh: true });
    assert.ok('id' in another);
    assert.notEqual(another.id, fresh.id);
    assert.equal((await journal.read()).records.length, 3);
  });

  it('should retain routing metadata and source references without copying provider prose', async () => {
    const first = await launch();
    const before = await journal.read();
    const retried = await launch();
    assert.ok('context' in retried && retried.context);
    assert.equal('body' in retried.context, false);
    assert.equal('comments' in retried.context, false);
    assert.equal('files' in retried.context, false);
    assert.match(String(retried.context.source), /github.com/);
    assert.deepEqual(retried, first);
    assert.deepEqual(JSON.parse(before.records[0]!.context!), retried.context);
    assert.deepEqual((await journal.read()).records, before.records);
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

  it('should isolate assignment data added to an operator-origin record', async () => {
    await launch();
    const raw = JSON.parse((await journal.file.read())!);
    raw.records[0].manualIssue.assignment = fixture.events[0];
    const contents = JSON.stringify(raw);
    await journal.file.write(contents);
    const isolated = await journal.read();
    assert.deepEqual(isolated.records, []);
    assert.deepEqual(
      isolated.isolatedRecords?.map(({ id, code }) => ({ id, code })),
      [{ id: raw.records[0].id, code: 'dispatch-task-record-invalid' }],
    );
    await assert.rejects(launch(), /dispatch-task-ownership-unresolved/);
    assert.equal(await journal.file.read(), contents);
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

  it('should preserve later unassignment when retrying an already consumed manual request', async () => {
    await launch();
    fixture.item.assignees = [];
    fixture.client.assignProjectIssue = async () =>
      assert.fail('retry must not restore a removed assignment');
    const retry = await launch(undefined, { operation: 'prepare' });
    assert.equal(retry.status, 'routing-required');
    assert.deepEqual(fixture.item.assignees, []);
    assert.equal((await store.read())!.observedAssignments!.length, 1);
  });

  it('should keep a prior automatic reservation as the assignment owner while launching independently', async () => {
    const { automationHash } = await import('../agent/automation-hash.ts');
    const { issueKey } = await import('../agent/tasks/dispatch/dispatch-pending.ts');
    const intakeId = automationHash([
      journal.scope,
      fixture.repository.nodeId,
      fixture.item.nodeId,
      fixture.events[0]!.nodeId,
    ]);
    await launch();
    await journal.exclusive(async (state, save) => {
      const manual = state.records[0]!.manualIssue!;
      state.records = [
        {
          id: 'f'.repeat(64),
          intakeId,
          issueKey: issueKey(manual),
          sourceThreadId: 'scheduled-intake',
          manifestDigest: state.records[0]!.manifestDigest,

          createdAt: baseline,
        },
      ];
      await save();
    });
    // emulate an automatic reservation that predates manual assignment consumption.
    await store.exclusive(async (state, save) => {
      delete state!.observedAssignments;
      await save(state!);
    });
    context.inputId = 'manual-beside-automatic';
    const launched = await launch();
    assert.equal(launched.status, 'routing-required');
    assert.equal((await journal.read()).records.length, 2);
    assert.equal((await store.read())!.observedAssignments![0]!.consumedBy, 'f'.repeat(64));
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

  it('should recover the active request beside a superseded attempt and allow a new operator request', async () => {
    await launch();
    await journal.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.threadId = 'current-chat';
      const previous = structuredClone(record);
      previous.id = 'b'.repeat(64);
      previous.manualIssue!.id = previous.id;
      previous.threadId = 'old-chat';
      previous.supersededBy = record.id;
      record.predecessorId = previous.id;
      state.records.unshift(previous);
      await save();
    });
    const before = await journal.read();
    const result = await launch();
    assert.ok('destination' in result && result.destination === 'current-chat');
    context.inputId = 'another-launch';
    const next = await launch();
    assert.equal(next.status, 'routing-required');
    assert.deepEqual(
      (await journal.read()).records.slice(0, before.records.length),
      before.records,
    );
  });

  it('should reject a superseded launch request without creating another replacement', async () => {
    await launch();
    await journal.exclusive(async (state, save) => {
      state.records[0]!.supersededBy = 'b'.repeat(64);
      await save();
    });
    const before = await journal.read();
    await assert.rejects(launch(), /launch-owner-inactive/);
    await assert.rejects(
      launch(undefined, { id: before.records[0]!.id } as unknown as Partial<LaunchRequest>),
      /launch-request-invalid/,
    );
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

  it('should preserve live operator direction and reuse an idle owner without recreation', async () => {
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
    const before = await journal.read();
    await launch();
    assert.equal((await journal.read()).records[0]!.id, before.records[0]!.id);
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
        routing: [],
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
