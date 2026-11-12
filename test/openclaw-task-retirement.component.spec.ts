import { GatewayClientRequestError } from '@openclaw/gateway-client';
import assert from 'node:assert/strict';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import OpenClawDispatch from '../agent/tasks/dispatch/openclaw-dispatch.ts';
import GitWorktreeConflict from '../tools/git/worktree-conflict.ts';
import { baseline } from './github-intake-fixture.ts';
import openclawDispatchFixture from './openclaw-dispatch-fixture.ts';

describe('agent/openclaw task-retirement', () => {
  const fixtureState = openclawDispatchFixture();
  it('should consume native settings and hold invalid cleanup settings while retaining the original deadline', async () => {
    const { items } = await fixtureState.assignments(1, 1);
    const selected = await fixtureState.next();
    await fixtureState.prepare(selected);
    await fixtureState.assess(selected.id);
    await fixtureState.completeAssessment(selected.id);
    fixtureState.config.plugins = {
      entries: { 'agent-system': { config: { cleanup: { graceMinutes: 17 } } } },
    };
    items[0]!.state = 'closed';
    fixtureState.service.dependencies.now = () => baseline + 180_001;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const original = await fixtureState.record();
    assert.equal(original.retirement?.eligibleAt, baseline + 180_001 + 17 * 60_000);
    fixtureState.config.plugins!.entries!['agent-system']!.config!.cleanup = { graceMinutes: -1 };
    fixtureState.service.dependencies.now = () => original.retirement!.eligibleAt;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const blocked = await fixtureState.record();
    assert.ok(blocked);
    assert.equal(blocked.retirement?.code, 'retirement-configuration-invalid');
    assert.ok(
      blocked.retirement?.diagnostic?.includes('plugins.entries.agent-system.config.cleanup'),
    );
    assert.equal(blocked.retirement?.eligibleAt, original.retirement!.eligibleAt);
    assert.equal(
      fixtureState.calls.some((call) => call.method === 'sessions.patch' && call.params.archived),
      false,
    );
    fixtureState.config.plugins!.entries!['agent-system']!.config!.cleanup = { graceMinutes: 0 };
    fixtureState.service.dependencies.now = () => original.retirement!.eligibleAt + 60_000;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const resumed = await fixtureState.record();
    assert.notEqual(resumed.retirement?.code, 'retirement-configuration-invalid');
    assert.equal(resumed.retirement?.eligibleAt, original.retirement!.eligibleAt);
  });

  it('should defer native cleanup if grace changes during preservation verification', async () => {
    const { items } = await fixtureState.assignments(1, 1);
    const selected = await fixtureState.next();
    await fixtureState.prepare(selected);
    await fixtureState.assess(selected.id);
    await fixtureState.completeAssessment(selected.id);
    fixtureState.config.plugins = {
      entries: { 'agent-system': { config: { cleanup: { graceMinutes: 0 } } } },
    };
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
      if (input.verifyOnly)
        fixtureState.config.plugins!.entries!['agent-system']!.config!.cleanup = {
          graceMinutes: 17,
        };
      return {
        ...input.worktree,
        repositoryId: 'github-10',
        workId: 'issue-20',
        status: input.verifyOnly ? 'preserved' : 'removed',
      };
    };
    items[0]!.state = 'closed';
    fixtureState.service.dependencies.now = () => baseline + 180_001;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const deferred = await fixtureState.record();
    assert.ok(deferred);
    assert.equal(deferred.retirement?.code, 'retirement-configuration-changed');
    assert.equal(
      fixtureState.calls.some((call) => call.method === 'sessions.patch' && call.params.archived),
      false,
    );
    assert.equal(deferred.retirement?.worktreeRemovalAttemptedAt, undefined);
  });

  it('should retire old coordinator tasks after replacement and preserve active sibling work', async () => {
    const { items } = await fixtureState.assignments(2, 2);
    const first = await fixtureState.next();
    await fixtureState.prepare(first);
    await fixtureState.assess(first.id);
    const second = await fixtureState.next();
    await fixtureState.prepare(second);
    await fixtureState.assess(second.id);
    await fixtureState.completeAssessment(first.id);
    await fixtureState.completeAssessment(second.id);
    const closed = structuredClone(
      await fixtureState.record(fixtureState.assessor(first.id).sessionKey),
    );
    const sibling = structuredClone(
      await fixtureState.record(fixtureState.assessor(second.id).sessionKey),
    );
    const siblingSession = structuredClone(fixtureState.sessions.get(sibling.threadId!)!);
    const inspect = fixtureState.service.dependencies.worktrees.inspectGitHub;
    const removed = new Set<string>();
    const effects: Array<[string, string]> = [];
    fixtureState.service.dependencies.worktrees.inspectGitHub = async (...args) => {
      const tree = await inspect(...args);
      return tree && !removed.has(tree.path) ? tree : undefined;
    };
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
      assert.equal(input.attemptId, closed.id);
      effects.push([input.verifyOnly ? 'verify' : 'remove', input.worktree.path]);
      if (!input.verifyOnly) {
        removed.add(input.worktree.path);
        await rm(input.worktree.path, { recursive: true });
      }
      return {
        ...input.worktree,
        repositoryId: 'github-10',
        workId: 'issue-20',
        status: input.verifyOnly ? 'preserved' : 'removed',
      };
    };
    const replacement = {
      ...fixtureState.coordinator,
      sessionKey: 'agent:receiver:automation:replacement',
    };
    fixtureState.service.dependencies.coordinator = async () => replacement.sessionKey;
    await assert.rejects(
      fixtureState.service.run(fixtureState.manifest, fixtureState.root, fixtureState.coordinator, {
        action: 'next',
      }),
      /dispatch-intake-caller-required/,
    );
    items[0]!.state = 'closed';
    fixtureState.service.dependencies.now = () => baseline + 180_001;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...replacement, runId: 'close' },
      { action: 'next' },
    );
    const pending = await fixtureState.record(closed.threadId);
    assert.equal(pending.retirement?.reason, 'issue-closed');
    assert.equal(pending.sourceThreadId, closed.sourceThreadId);
    assert.ok(pending);
    assert.deepEqual(effects, []);
    fixtureState.service.dependencies.now = () => pending.retirement!.eligibleAt;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...replacement, runId: 'cleanup' },
      { action: 'next' },
    );
    assert.deepEqual(effects, [
      ['verify', closed.worktree!],
      ['remove', closed.worktree!],
    ]);
    assert.equal(fixtureState.sessions.get(closed.threadId!)!.archived, true);
    assert.equal(await fixtureState.record(closed.threadId), undefined);
    await assert.rejects(stat(closed.worktree!), { code: 'ENOENT' });
    const retained = await fixtureState.record(sibling.threadId);
    assert.equal(retained.retirement, undefined);
    assert.ok(retained);
    assert.equal(retained.threadId, sibling.threadId);
    assert.equal(retained.worktree, sibling.worktree);
    assert.deepEqual(fixtureState.sessions.get(sibling.threadId!), siblingSession);
    assert.ok((await stat(sibling.worktree!)).isDirectory());
    assert.deepEqual(
      fixtureState.calls
        .filter((call) => call.method === 'sessions.patch')
        .map(({ params }) => params.key),
      [closed.threadId],
    );
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...replacement, runId: 'again' },
      { action: 'next' },
    );
    assert.equal(effects.length, 2);
  });

  for (const protection of ['none', 'running', 'pinned', 'dirty', 'invalid-config'] as const) {
    it(`should retire old coordinator tasks manually with native protection: ${protection}`, async () => {
      await fixtureState.assignments(1, 1);
      const first = await fixtureState.next();
      await fixtureState.prepare(first);
      await fixtureState.assess(first.id);
      await fixtureState.completeAssessment(first.id);
      const before = structuredClone(await fixtureState.record());
      fixtureState.service.dependencies.coordinator = async () =>
        'agent:receiver:automation:replacement';
      const operator = {
        ...fixtureState.coordinator,
        sessionKey: 'agent:receiver:operator',
        sessionId: 'operator-id',
      };
      const retire = (digest?: string) =>
        fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          operator,
          { action: 'retire', id: first.id, ...(digest ? { digest } : {}) },
          true,
        );
      let removed = false;
      fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
        if (protection === 'dirty' && !input.purge)
          return {
            ...input.worktree,
            repositoryId: 'github-10',
            workId: 'issue-20',
            status: 'dirty',
          };
        if (!input.verifyOnly) removed = true;
        return {
          ...input.worktree,
          repositoryId: 'github-10',
          workId: 'issue-20',
          status: input.verifyOnly ? 'preserved' : 'removed',
        };
      };
      if (protection === 'invalid-config')
        fixtureState.config.plugins = {
          entries: { 'agent-system': { config: { cleanup: { graceMinutes: -1 } } } },
        };
      if (protection === 'running') fixtureState.histories.get(before.threadId!)!.active = true;
      if (protection === 'pinned') fixtureState.sessions.get(before.threadId!)!.pinned = true;
      await assert.rejects(
        fixtureState.service.run(fixtureState.manifest, fixtureState.root, operator, {
          action: 'retire',
          id: first.id,
        }),
        /dispatch-operator-required/,
      );
      const preview = await retire();
      assert.equal(preview.status, 'retire-available');
      assert.deepEqual(await fixtureState.record(), before);
      await assert.rejects(retire('f'.repeat(64)), /dispatch-recovery-stale/);
      const applied = await retire('digest' in preview ? String(preview.digest) : '');
      const pending = protection === 'running';
      assert.equal(applied.status, pending ? 'retirement-pending' : 'retired');
      const after = await fixtureState.record();
      assert.equal(removed, !pending);
      assert.equal(fixtureState.fixture.item.state, 'open');
      if (pending) {
        assert.equal(after.retirement!.reason, 'operator-requested');
        assert.equal(after.retirement!.eligibleAt, fixtureState.service.dependencies.now!());
        assert.equal(after.cleanupPending, true);
        assert.equal(
          fixtureState.calls.some((call) => call.method === 'sessions.patch'),
          false,
        );
      } else {
        assert.equal(after, undefined);
        assert.equal(
          fixtureState.calls.filter((call) => call.method === 'sessions.patch').length,
          1,
        );
        const consumed = (await (
          await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
        ).store.read())!.observedAssignments;
        assert.ok(consumed?.some((entry) => entry.consumedBy === first.id));
      }
    });
  }

  it('should reject a retirement preview after live settings or native identity changes', async () => {
    await fixtureState.prepare(await fixtureState.next());
    const target = await fixtureState.record();
    const operator = {
      ...fixtureState.coordinator,
      sessionKey: 'operator',
      sessionId: 'operator-id',
    };
    const retire = (digest?: string) =>
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        operator,
        { action: 'retire', id: target.id, digest },
        true,
      );
    const preview = await retire();
    fixtureState.config.plugins = {
      entries: { 'agent-system': { config: { cleanup: { graceMinutes: 9 } } } },
    };
    await assert.rejects(
      retire('digest' in preview ? String(preview.digest) : ''),
      /dispatch-recovery-stale/,
    );
    assert.equal((await fixtureState.record()).retirement, undefined);
    fixtureState.session!.sessionId = 'replacement';
    await assert.rejects(retire(), /retirement-session-identity-changed/);
    assert.equal((await fixtureState.record()).retirement, undefined);
    assert.equal(
      fixtureState.calls.some((call) => call.method === 'sessions.patch'),
      false,
    );
  });

  it('should allow verified operator retirement of another task from a managed session', async () => {
    await fixtureState.assignments(2, 2);
    const first = await fixtureState.next();
    await fixtureState.prepare(first);
    await fixtureState.assess(first.id);
    const second = await fixtureState.next();
    await fixtureState.prepare(second);
    await fixtureState.assess(second.id);
    const caller = fixtureState.assessor(second.id);
    const before = structuredClone(await fixtureState.record(caller.sessionKey));
    const retire = (digest?: string, operator = true, sessionId = caller.sessionId) =>
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...caller, sessionId },
        { action: 'retire', id: first.id, digest },
        operator,
      );
    await assert.rejects(retire(undefined, false), /dispatch-operator-required/);
    await assert.rejects(retire(undefined, true, 'stale'), /dispatch-retire-context-mismatch/);
    assert.equal(
      (await fixtureState.record(fixtureState.assessor(first.id).sessionKey)).retirement,
      undefined,
    );
    const preview = await retire();
    assert.equal(preview.status, 'retire-available');
    const applied = await retire('digest' in preview ? String(preview.digest) : '');
    assert.equal(applied.status, 'retirement-pending');
    const target = await fixtureState.record(fixtureState.assessor(first.id).sessionKey);
    assert.equal(target.retirement!.operatorRequest!.caller, caller.sessionKey);
    assert.equal(target.retirement!.operatorRequest!.targetId, first.id);
    assert.deepEqual(await fixtureState.record(caller.sessionKey), before);
  });

  it('should accept the exact current task but leave its active invocation pending', async () => {
    const first = await fixtureState.next();
    await fixtureState.prepare(first);
    await fixtureState.assess(first.id);
    const caller = fixtureState.assessor(first.id);
    await assert.rejects(
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...caller, sessionId: 'stale' },
        { action: 'retire' },
        true,
      ),
      /dispatch-retire-context-mismatch/,
    );
    await assert.rejects(
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        caller,
        { action: 'retire', id: 'f'.repeat(64) },
        true,
      ),
      /dispatch-retire-target-mismatch/,
    );
    const preview = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      caller,
      { action: 'retire' },
      true,
    );
    assert.equal(preview.status, 'retire-available');
    const applied = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      caller,
      { action: 'retire', digest: 'digest' in preview ? String(preview.digest) : '' },
      true,
    );
    assert.equal(applied.status, 'retirement-pending');
    assert.equal(
      (await fixtureState.record()).retirement!.code,
      'retirement-native-work-unresolved',
    );
    assert.equal(
      fixtureState.calls.some((call) => call.method === 'sessions.patch'),
      false,
    );
  });

  it('should preserve a genuinely shared checkout even when both tasks are eligible', async () => {
    const { items } = await fixtureState.assignments(2, 2);
    const sharedTree = {
      path: join(fixtureState.root, 'shared'),
      branch: 'shared',
      repositoryId: 'github-10',
      workId: 'shared',
      status: 'existing' as const,
    };
    await mkdir(sharedTree.path);
    let removals = 0;
    fixtureState.service.dependencies.worktrees.prepareGitHub = async () => sharedTree;
    fixtureState.service.dependencies.worktrees.inspectGitHub = async () =>
      removals ? undefined : sharedTree;
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
      if (!input.verifyOnly) {
        removals++;
      }
      return { ...sharedTree, status: input.verifyOnly ? 'preserved' : 'removed' };
    };
    await fixtureState.prepare(await fixtureState.next());
    await fixtureState.prepare(await fixtureState.next());
    for (const item of items) item.state = 'closed';
    fixtureState.service.dependencies.now = () => baseline + 180_001;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'close' },
      { action: 'next' },
    );
    const deadline = (await fixtureState.record()).retirement!.eligibleAt;
    fixtureState.service.dependencies.now = () => deadline;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'cleanup' },
      { action: 'next' },
    );
    fixtureState.service.dependencies.now = () => deadline + 60_000;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'finish' },
      { action: 'next' },
    );
    const state = await (
      await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
    ).journal.read();
    assert.equal(state.records.length, 2);
    assert.ok(
      state.records.every((entry) => entry.retirement?.code === 'retirement-worktree-shared'),
    );
    assert.equal(removals, 0);
    assert.equal(fixtureState.calls.filter((call) => call.method === 'sessions.patch').length, 0);
  });

  for (const leftover of ['renamed', 'modified', 'untracked'] as const) {
    it(`should archive and retire a closed checkout with ${leftover} leftovers`, async () => {
      const { items } = await fixtureState.assignments(1, 1);
      const first = await fixtureState.next();
      await fixtureState.prepare(first);
      await fixtureState.assess(first.id);
      await fixtureState.completeAssessment(first.id);
      const before = structuredClone(await fixtureState.record());
      const inspect = fixtureState.service.dependencies.worktrees.inspectGitHub;
      let removed = false;
      fixtureState.service.dependencies.worktrees.inspectGitHub = async (input) => {
        if (removed) return undefined;
        if (leftover === 'renamed' && input.closedIssueWorktree !== before.worktree)
          throw new GitWorktreeConflict('owner-mismatch', 'changed branch');
        const tree = await inspect(input);
        return tree && { ...tree, branch: leftover === 'renamed' ? 'renamed' : tree.branch };
      };
      fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
        if (leftover !== 'renamed' && !input.purge)
          return {
            ...input.worktree,
            repositoryId: 'github-10',
            workId: 'issue-20',
            status: 'dirty',
          };
        if (!input.verifyOnly) {
          assert.equal(fixtureState.session!.archived, true);
          removed = true;
          await rm(input.worktree.path, { recursive: true });
        }
        return {
          ...input.worktree,
          repositoryId: 'github-10',
          workId: 'issue-20',
          status: input.verifyOnly ? 'preserved' : 'removed',
        };
      };
      items[0]!.state = 'closed';
      fixtureState.service.dependencies.now = () => baseline + 180_001;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      fixtureState.service.dependencies.now = () => before.createdAt + 24 * 60 * 60_000;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'cleanup' },
        { action: 'next' },
      );
      const after = await fixtureState.record();
      assert.equal(after, undefined);
      assert.equal(removed, true);
    });
  }

  it('should reconcile interrupted worktree removal without repeating native archival or removal', async () => {
    await fixtureState.prepare(await fixtureState.next());
    const inspect = fixtureState.service.dependencies.worktrees.inspectGitHub;
    let removed = false;
    let removals = 0;
    fixtureState.service.dependencies.worktrees.inspectGitHub = async (...args) =>
      removed ? undefined : inspect(...args);
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
      if (!input.verifyOnly) {
        removals++;
        await rm(input.worktree.path, { recursive: true, force: true });
        removed = true;
        throw new Error('lost-cleanup-response');
      }
      return {
        ...input.worktree,
        repositoryId: 'github-10',
        workId: 'issue-20',
        status: 'preserved',
      };
    };
    fixtureState.fixture.item.state = 'closed';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const deadline = (await fixtureState.record()).retirement!.eligibleAt;
    fixtureState.service.dependencies.now = () => deadline;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'cleanup' },
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).retirement?.code, 'lost-cleanup-response');
    assert.ok(await fixtureState.record());
    fixtureState.service = new OpenClawDispatch({
      ...fixtureState.service.dependencies,
      now: () => deadline + 60_000,
    });
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'recover' },
      { action: 'next' },
    );
    assert.equal(await fixtureState.record(), undefined);
    assert.equal(removals, 1);
    assert.equal(fixtureState.calls.filter((call) => call.method === 'sessions.patch').length, 1);
  });

  it('should reconcile external worktree removal after verifying current session custody', async () => {
    await fixtureState.prepare(await fixtureState.next());
    const before = structuredClone(await fixtureState.record());
    fixtureState.service.dependencies.worktrees.inspectGitHub = async () => undefined;
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async () => {
      throw new Error('must-not-remove');
    };
    fixtureState.fixture.item.state = 'closed';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const deadline = (await fixtureState.record()).retirement!.eligibleAt;
    fixtureState.service.dependencies.now = () => deadline;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'still-present' },
      { action: 'next' },
    );
    assert.equal(
      (await fixtureState.record()).retirement?.code,
      'retirement-worktree-observation-required',
    );
    assert.equal(fixtureState.session!.archived, undefined);
    await rm(before.worktree!, { recursive: true });
    fixtureState.service = new OpenClawDispatch({
      ...fixtureState.service.dependencies,
      now: () => deadline + 60_000,
    });
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'external-cleanup' },
      { action: 'next' },
    );
    const after = await fixtureState.record();
    assert.equal(after, undefined);
    fixtureState.service.dependencies.now = () => deadline + 120_000;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'repeat' },
      { action: 'next' },
    );
    assert.equal(fixtureState.calls.filter((call) => call.method === 'sessions.patch').length, 1);
    assert.equal(fixtureState.creates().length, 1);
  });

  for (const shape of ['current', 'denied'] as const) {
    for (const tree of ['existing', 'absent'] as const) {
      it(`should retire ${shape} unavailable sessions with an ${tree} worktree without invented archival`, async () => {
        await fixtureState.prepare(await fixtureState.next());
        const before = structuredClone(await fixtureState.record());
        fixtureState.session = null;
        if (shape === 'denied')
          fixtureState.describeError = new GatewayClientRequestError({
            code: 'FORBIDDEN',
            message: 'private',
          });
        let removed = tree === 'absent';
        let removals = 0;
        const inspect = fixtureState.service.dependencies.worktrees.inspectGitHub;
        fixtureState.service.dependencies.worktrees.inspectGitHub = async (...args) =>
          removed ? undefined : inspect(...args);
        if (removed) await rm(before.worktree!, { recursive: true });
        fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
          if (!input.verifyOnly) {
            const persisted = await fixtureState.record();
            assert.ok(persisted.retirement?.sessionUnavailableObserved);
            assert.equal(persisted.retirement?.archivedAt, undefined);
            assert.equal(persisted.retirement?.worktreeRemovalAttemptedAt !== undefined, true);
            removals++;
            await rm(input.worktree.path, { recursive: true });
            removed = true;
          }
          return {
            ...input.worktree,
            repositoryId: 'github-10',
            workId: 'issue-20',
            status: input.verifyOnly ? 'preserved' : 'removed',
          };
        };
        fixtureState.fixture.item.state = 'closed';
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        );
        assert.ok(await fixtureState.record());
        assert.equal(removals, 0);
        const deadline = (await fixtureState.record()).retirement!.eligibleAt;
        fixtureState.service = new OpenClawDispatch({
          ...fixtureState.service.dependencies,
          now: () => deadline,
        });
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          { ...fixtureState.coordinator, runId: 'recover' },
          { action: 'next' },
        );
        const after = await fixtureState.record();
        if (shape === 'denied') {
          assert.ok(after);
          assert.ok(after);
          assert.equal(after.retirement?.code, 'retirement-native-access-denied');
          assert.equal(removals, 0);
        } else {
          assert.equal(after, undefined);
          assert.equal(removals, tree === 'existing' ? 1 : 0);
          await assert.rejects(stat(before.worktree!), { code: 'ENOENT' });
        }
        fixtureState.service.dependencies.now = () => deadline + 60_000;
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          { ...fixtureState.coordinator, runId: 'repeat' },
          { action: 'next' },
        );
        assert.equal(removals, tree === 'existing' && shape !== 'denied' ? 1 : 0);
        assert.equal(fixtureState.creates().length, 1);
        assert.equal(
          fixtureState.calls.filter((call) => call.method === 'sessions.patch').length,
          0,
        );
      });
    }
  }

  for (const refusal of ['dirty', 'unpreserved'] as const) {
    it(`should retain an unavailable session worktree when preservation is ${refusal}`, async () => {
      await fixtureState.prepare(await fixtureState.next());
      fixtureState.session = null;
      let removals = 0;
      fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
        if (!input.verifyOnly) removals++;
        return {
          ...input.worktree,
          repositoryId: 'github-10',
          workId: 'issue-20',
          status: refusal,
        };
      };
      fixtureState.fixture.item.state = 'closed';
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      const deadline = (await fixtureState.record()).retirement!.eligibleAt;
      fixtureState.service.dependencies.now = () => deadline;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'blocked' },
        { action: 'next' },
      );
      const after = await fixtureState.record();
      assert.ok(after);
      assert.equal(after.retirement?.code, `retirement-worktree-${refusal}`);
      assert.equal(after.retirement?.archivedAt, undefined);
      assert.equal(removals, 0);
      assert.ok((await stat(after.worktree!)).isDirectory());
    });
  }

  it('should stop inferred cleanup if the session becomes accessible during preservation', async () => {
    await fixtureState.prepare(await fixtureState.next());
    const original = fixtureState.session;
    fixtureState.session = null;
    let removals = 0;
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
      if (input.verifyOnly) fixtureState.session = original;
      else removals++;
      return {
        ...input.worktree,
        repositoryId: 'github-10',
        workId: 'issue-20',
        status: input.verifyOnly ? 'preserved' : 'removed',
      };
    };
    fixtureState.fixture.item.state = 'closed';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const deadline = (await fixtureState.record()).retirement!.eligibleAt;
    fixtureState.service.dependencies.now = () => deadline;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'changed' },
      { action: 'next' },
    );
    assert.ok(await fixtureState.record());
    assert.equal((await fixtureState.record()).retirement?.code, 'retirement-observation-changed');
    assert.equal(removals, 0);
  });

  it('should reconcile lost unavailable-session cleanup without repeating removal', async () => {
    await fixtureState.prepare(await fixtureState.next());
    fixtureState.session = null;
    const inspect = fixtureState.service.dependencies.worktrees.inspectGitHub;
    let removed = false;
    let removals = 0;
    fixtureState.service.dependencies.worktrees.inspectGitHub = async (...args) =>
      removed ? undefined : inspect(...args);
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
      if (!input.verifyOnly) {
        removals++;
        await rm(input.worktree.path, { recursive: true });
        removed = true;
        throw new Error('lost-cleanup-response');
      }
      return {
        ...input.worktree,
        repositoryId: 'github-10',
        workId: 'issue-20',
        status: 'preserved',
      };
    };
    fixtureState.fixture.item.state = 'closed';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const deadline = (await fixtureState.record()).retirement!.eligibleAt;
    fixtureState.service.dependencies.now = () => deadline;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'lost' },
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).retirement?.code, 'lost-cleanup-response');
    assert.ok(await fixtureState.record());
    fixtureState.service = new OpenClawDispatch({
      ...fixtureState.service.dependencies,
      now: () => deadline + 60_000,
    });
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'reconcile' },
      { action: 'next' },
    );
    const after = await fixtureState.record();
    assert.equal(after, undefined);
    assert.equal(removals, 1);
    assert.equal(fixtureState.calls.filter((call) => call.method === 'sessions.patch').length, 0);
  });

  it('should keep transient session read failures pending without removing work', async () => {
    await fixtureState.prepare(await fixtureState.next());
    fixtureState.describeError = new GatewayClientRequestError({
      code: 'UNAVAILABLE',
      message: 'temporary',
    });
    fixtureState.fixture.item.state = 'closed';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const deadline = (await fixtureState.record()).retirement!.eligibleAt;
    fixtureState.service.dependencies.now = () => deadline;
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async () => {
      throw new Error('must-not-clean');
    };
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'outage' },
      { action: 'next' },
    );
    const after = await fixtureState.record();
    assert.ok(after);
    assert.equal(after.retirement?.sessionUnavailableObserved, undefined);
    assert.equal(after.retirement?.code, 'session-dispatch-describe-unavailable-unverified');
    assert.ok((await stat(after.worktree!)).isDirectory());
  });

  it('should not bypass automation ownership when the session is missing', async () => {
    await fixtureState.prepare(await fixtureState.next());
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async () => {
      throw new Error('must-not-clean');
    };
    fixtureState.cronJobs = [
      { sessionTarget: `session:${(await fixtureState.record()).threadId}` },
    ];
    fixtureState.session = null;
    fixtureState.fixture.item.state = 'closed';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const deadline = (await fixtureState.record()).retirement!.eligibleAt;
    fixtureState.service.dependencies.now = () => deadline;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'owned' },
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).retirement?.code, 'retirement-automation-owner');
    assert.ok(await fixtureState.record());
  });

  it('should preserve a session targeted by a native automation', async () => {
    await fixtureState.prepare(await fixtureState.next());
    fixtureState.cronJobs = [
      { sessionTarget: `session:${(await fixtureState.record()).threadId}` },
    ];
    fixtureState.fixture.item.state = 'closed';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const deadline = (await fixtureState.record()).retirement!.eligibleAt;
    fixtureState.service.dependencies.now = () => deadline;
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async () => {
      throw new Error('must-not-remove');
    };
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'cleanup' },
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).retirement?.code, 'retirement-automation-owner');
    assert.equal(fixtureState.session!.archived, undefined);
  });

  it('should retire a pinned closed session with terminal input history through ordinary reconciliation', async () => {
    await fixtureState.prepare(await fixtureState.next());
    fixtureState.session!.pinned = true;
    fixtureState.fixture.item.state = 'closed';
    fixtureState.terminalInputs = [
      { id: 'cancelled', state: 'cancelled' },
      { id: 'interrupted', state: 'interrupted' },
    ];
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const pending = await fixtureState.record();
    fixtureState.service.dependencies.now = () => pending.retirement!.eligibleAt;
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
      if (!input.verifyOnly) await rm(input.worktree.path, { recursive: true });
      return {
        ...input.worktree,
        repositoryId: 'github-10',
        workId: 'issue-20',
        status: input.verifyOnly ? 'preserved' : 'removed',
      };
    };
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'cleanup' },
      { action: 'next' },
    );
    assert.equal(fixtureState.session!.archived, true);
    assert.equal(await fixtureState.record(), undefined);
  });

  for (const kind of [
    'incidental',
    'disabled',
    'running-disabled',
    'command-cwd',
    'later-page',
  ] as const) {
    it(`should distinguish structured automation custody from ${kind} state`, async () => {
      await fixtureState.prepare(await fixtureState.next());
      const target = await fixtureState.record();
      const job = { sessionTarget: `session:${target.threadId}` };
      fixtureState.cronJobs =
        kind === 'incidental'
          ? [
              {
                description: target.threadId,
                payload: { kind: 'agentTurn', message: target.threadId },
              },
            ]
          : kind === 'command-cwd'
            ? [{ payload: { kind: 'command', cwd: target.worktree } }]
            : kind === 'later-page'
              ? [...Array.from({ length: 200 }, () => ({})), job]
              : [
                  {
                    ...job,
                    enabled: false,
                    state: kind === 'running-disabled' ? { runningAtMs: baseline } : {},
                  },
                ];
      let removals = 0;
      fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
        if (!input.verifyOnly) removals++;
        return {
          ...input.worktree,
          repositoryId: 'github-10',
          workId: 'issue-20',
          status: input.verifyOnly ? 'preserved' : 'removed',
        };
      };
      fixtureState.fixture.item.state = 'closed';
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      const deadline = (await fixtureState.record()).retirement!.eligibleAt;
      fixtureState.service.dependencies.now = () => deadline;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'cleanup' },
        { action: 'next' },
      );
      const protectedResource = !['incidental', 'disabled'].includes(kind);
      assert.equal(removals, protectedResource ? 0 : 1);
      assert.equal(Boolean(await fixtureState.record()), protectedResource);
      if (protectedResource)
        assert.equal((await fixtureState.record()).retirement?.code, 'retirement-automation-owner');
    });
  }

  for (const retainedDenial of [false, true]) {
    it(`should preserve a closed checkout after ${retainedDenial ? 'retained' : 'new'} archive denial until native archival is observed`, async () => {
      await fixtureState.prepare(await fixtureState.next());
      const target = await fixtureState.record();
      const inspect = fixtureState.service.dependencies.worktrees.inspectGitHub;
      let removed = false;
      let removals = 0;
      fixtureState.service.dependencies.worktrees.inspectGitHub = async (...args) =>
        removed ? undefined : inspect(...args);
      fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
        if (!input.verifyOnly) {
          removals++;
          removed = true;
          await rm(input.worktree.path, { recursive: true });
        }
        return {
          ...input.worktree,
          repositoryId: 'github-10',
          workId: 'issue-20',
          status: input.verifyOnly ? 'preserved' : 'removed',
        };
      };
      fixtureState.archiveError = true;
      fixtureState.fixture.item.state = 'closed';
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      const deadline = (await fixtureState.record()).retirement!.eligibleAt;
      if (retainedDenial) {
        await (
          await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
        ).journal.exclusive(async (state, save) => {
          state.records.find((entry) => entry.id === target.id)!.retirement!.code =
            'session-dispatch-sessions-patch-forbidden';
          await save();
        });
      }
      fixtureState.service.dependencies.now = () => deadline;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'denied' },
        { action: 'next' },
      );
      const pending = await fixtureState.record();
      assert.ok(pending);
      assert.equal(
        pending.retirement?.archiveRequest?.sessionId,
        target.sessionCreation!.sessionId,
      );
      assert.equal(pending.retirement?.archivedAt, undefined);
      assert.equal(pending.retirement?.worktreeRemovedAt, undefined);
      assert.equal(pending.retirement?.code, 'session-dispatch-sessions-patch-forbidden');
      fixtureState.service.dependencies.now = () => deadline + 60_000;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'reconcile-denial' },
        { action: 'next' },
      );
      assert.equal(removals, 0);
      assert.equal(
        fixtureState.calls.filter(({ method }) => method === 'sessions.patch').length,
        retainedDenial ? 0 : 1,
      );
      assert.ok(await fixtureState.record());
      fixtureState.session!.archived = true;
      fixtureState.service.dependencies.now = () => deadline + 120_000;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'observe-archive' },
        { action: 'next' },
      );
      assert.equal(await fixtureState.record(), undefined);
      assert.equal(
        fixtureState.calls.filter(({ method }) => method === 'sessions.patch').length,
        retainedDenial ? 0 : 1,
      );
    });
  }

  it('should retain a refused worktree effect without repeating removal or losing its diagnostic', async () => {
    await fixtureState.prepare(await fixtureState.next());
    let removals = 0;
    fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
      if (!input.verifyOnly) removals++;
      return {
        ...input.worktree,
        repositoryId: 'github-10',
        workId: 'issue-20',
        status: input.verifyOnly ? 'preserved' : 'failed',
      };
    };
    fixtureState.fixture.item.state = 'closed';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const deadline = (await fixtureState.record()).retirement!.eligibleAt;
    fixtureState.service.dependencies.now = () => deadline;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'refuse-removal' },
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).retirement?.code, 'retirement-worktree-failed');
    fixtureState.service.dependencies.now = () => deadline + 60_000;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'reconcile-removal' },
      { action: 'next' },
    );
    assert.equal(removals, 1);
    assert.equal((await fixtureState.record()).retirement?.code, 'retirement-worktree-failed');
    assert.equal(
      (await fixtureState.record()).retirement?.worktreeRemovalCode,
      'retirement-worktree-failed',
    );
    assert.ok(await fixtureState.record());
    assert.equal(fixtureState.calls.filter(({ method }) => method === 'sessions.patch').length, 1);
  });

  for (const helperState of ['listed', 'omitted', 'active'] as const)
    it(`should verify ${helperState} native helper custody before closed task disposal`, async () => {
      await fixtureState.prepare(await fixtureState.next());
      const target = await fixtureState.record();
      const helper = {
        key: 'agent:receiver:subagent:helper',
        agentId: 'receiver',
        sessionId: 'helper-incarnation',
        spawnedCwd: target.worktree,
        parentSessionKey: target.threadId,
        status: 'done',
        archived: false,
        listed: helperState === 'listed',
        active: helperState === 'active',
      };
      const nested = {
        ...helper,
        key: 'agent:receiver:subagent:nested',
        sessionId: 'nested-incarnation',
        parentSessionKey: helper.key,
        listed: true,
        active: false,
      };
      fixtureState.foreignSessions = [nested, helper];
      let removals = 0;
      fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
        assert.equal(input.purge, true);
        if (!input.verifyOnly) {
          assert.equal(fixtureState.session!.archived, true);
          assert.equal(helper.archived, true);
          assert.equal(nested.archived, true);
          removals++;
        }
        return {
          ...input.worktree,
          repositoryId: 'github-10',
          workId: 'issue-20',
          status: input.verifyOnly ? 'preserved' : 'removed',
        };
      };
      fixtureState.fixture.item.state = 'closed';
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      fixtureState.service.dependencies.now = () => baseline + 24 * 60 * 60_000;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'cleanup' },
        { action: 'next' },
      );
      if (helperState === 'active') {
        assert.ok(await fixtureState.record());
        assert.equal(removals, 0);
        assert.equal(
          fixtureState.calls.filter(({ method }) => method === 'sessions.patch').length,
          0,
        );
        return;
      }
      assert.equal(await fixtureState.record(), undefined);
      assert.equal(removals, 1);
      assert.deepEqual(
        new Set(
          fixtureState.calls
            .filter(({ method }) => method === 'sessions.patch')
            .map(({ params }) => params.key),
        ),
        new Set([target.threadId, helper.key, nested.key]),
      );
    });

  for (const recovery of ['observed', 'replaced', 'archived-parent'] as const) {
    it(`should reconcile ${recovery} helper archival without replaying native refusal`, async () => {
      await fixtureState.prepare(await fixtureState.next());
      const target = await fixtureState.record();
      const helper = {
        key: 'agent:receiver:subagent:helper',
        agentId: 'receiver',
        sessionId: 'helper-id',
        spawnedCwd: target.worktree,
        parentSessionKey: target.threadId,
        archived: false,
      };
      fixtureState.foreignSessions = [helper];
      let removals = 0;
      fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
        if (!input.verifyOnly) removals++;
        return {
          ...input.worktree,
          repositoryId: 'github-10',
          workId: 'issue-20',
          status: input.verifyOnly ? 'preserved' : 'removed',
        };
      };
      fixtureState.fixture.item.state = 'closed';
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      let now = baseline + 24 * 60 * 60_000;
      fixtureState.service.dependencies.now = () => now;
      if (recovery === 'archived-parent') fixtureState.session!.archived = true;
      const expectedCalls = recovery === 'archived-parent' ? 1 : 2;
      fixtureState.archiveError = true;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'refused' },
        { action: 'next' },
      );
      assert.equal(
        (await fixtureState.record()).retirement?.code,
        'session-dispatch-sessions-patch-forbidden',
      );
      assert.equal(removals, 0);
      assert.equal(
        fixtureState.calls.filter(({ method }) => method === 'sessions.patch').length,
        expectedCalls,
      );
      fixtureState.archiveError = false;
      now += 60_000;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'reconcile' },
        { action: 'next' },
      );
      assert.equal(removals, 0);
      assert.equal(
        fixtureState.calls.filter(({ method }) => method === 'sessions.patch').length,
        expectedCalls,
      );
      if (recovery === 'archived-parent')
        assert.equal((await fixtureState.record()).retirement?.archiveRequest, undefined);
      fixtureState.session!.archived = true;
      helper.archived = true;
      if (recovery === 'replaced') helper.sessionId = 'replacement';
      now += 60_000;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'observe' },
        { action: 'next' },
      );
      assert.equal((await fixtureState.record()) === undefined, recovery !== 'replaced');
      assert.equal(removals, recovery !== 'replaced' ? 1 : 0);
      if (recovery === 'replaced')
        assert.equal(
          (await fixtureState.record()).retirement?.code,
          'retirement-session-identity-changed',
        );
      assert.equal(
        fixtureState.calls.filter(({ method }) => method === 'sessions.patch').length,
        expectedCalls,
      );
    });
  }

  for (const custody of [
    'unowned-session',
    'unrelated-helper',
    'cross-agent-helper',
    'incomplete-automations',
  ] as const) {
    it(`should retain checkout custody when native inventory reports ${custody}`, async () => {
      await fixtureState.prepare(await fixtureState.next());
      const target = await fixtureState.record();
      if (custody !== 'incomplete-automations')
        fixtureState.foreignSessions = [
          custody === 'unowned-session'
            ? { key: 'unowned', spawnedCwd: target.worktree }
            : {
                key: 'agent:receiver:subagent:unrelated',
                spawnedCwd: target.worktree,
                sessionId: 'other-id',
                agentId: custody === 'cross-agent-helper' ? 'other' : 'receiver',
                parentSessionKey: custody === 'cross-agent-helper' ? target.threadId : 'other',
              },
        ];
      else fixtureState.cronInventoryTotal = 1;
      let mutations = 0;
      fixtureState.service.dependencies.worktrees.cleanupGitHub = async () => {
        mutations++;
        throw new Error('must-not-clean');
      };
      fixtureState.fixture.item.state = 'closed';
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      const deadline = (await fixtureState.record()).retirement!.eligibleAt;
      fixtureState.service.dependencies.now = () => deadline;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'check-custody' },
        { action: 'next' },
      );
      const after = await fixtureState.record();
      assert.equal(
        after.retirement?.code,
        custody === 'incomplete-automations'
          ? 'retirement-automation-ownership-unavailable'
          : 'retirement-worktree-shared',
      );
      assert.ok(after);
      assert.equal(mutations, 0);
      assert.equal(
        fixtureState.calls.some(({ method }) => method === 'sessions.patch'),
        false,
      );
    });
  }
});
