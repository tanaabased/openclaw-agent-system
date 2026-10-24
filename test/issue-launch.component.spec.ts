import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';

import issueLaunch from '../agent/issue-launch.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import type { AssessmentEntryDependencies } from '../agent/assessment-entry.ts';
import { inspectAdmittedIssue, inspectContinuedIssue } from '../agent/dispatch-assignment.ts';
import { dispatchAdmission } from '../agent/managed-issue.ts';
import assessmentOwner from '../agent/assessment-owner.ts';
import pendingDispatchAssignments from '../agent/dispatch-pending.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

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
      git: async () => {
        throw new Error('unexpected git');
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
  const launch = (target = 'owner/repo#3') =>
    issueLaunch({
      action: { action: 'launch', operation: 'context', target },
      context,
      journal,
      scope: journal.scope,
      client: client(),
      create: (record) => record,
      verifyExisting: async () => {},
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
