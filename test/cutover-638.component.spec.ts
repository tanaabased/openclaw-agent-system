import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { omit } from 'lodash-es';

import { automationHash } from '../agent/automation-hash.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import type { CodexDeliveryState } from '../agent/codex-delivery-state.ts';
import type DispatchStore from '../agent/dispatch-state.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import retainDispatchHistory from '../agent/retain-dispatch-history.ts';
import IntakeRecordStore, {
  intakeLocation,
  type IntakeRecord,
  type IntakeState,
} from '../channels/github/intake/record-store.ts';
import cutover638, { type Cutover638Request } from '../scripts/cutover-638.ts';
import { account, intakeFixture } from './github-intake-fixture.ts';

describe('scripts/cutover-638', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cutover-638-test-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(runtime: 'codex' | 'openclaw') {
    const source = join(root, 'source');
    const dispatchRoot = join(source, runtime === 'codex' ? 'state' : 'dispatch');
    const intakeRoot = join(source, runtime === 'codex' ? 'state' : 'intake');
    await mkdir(dispatchRoot, { recursive: true, mode: 0o700 });
    await mkdir(intakeRoot, { recursive: true, mode: 0o700 });
    const request: Cutover638Request = {
      source,
      output: join(root, 'output'),
      runtime,
      namespace: '/fixture/runtime',
      workspace: '/fixture/workspace',
      agent: 'receiver',
    };
    const location = intakeLocation({
      runtime,
      root: intakeRoot,
      namespace: request.namespace,
      workspaceDir: request.workspace,
      agentId: request.agent,
      resetRoot: dispatchRoot,
    });
    const { repository, item, events } = intakeFixture();
    const admission = (event: string): IntakeRecord => ({
      version: 1,
      scope: location.scope,
      id: automationHash([location.scope, repository.nodeId, item.nodeId, event]),
      receiving: { login: account.login, nodeId: account.nodeId },
      workspaceDir: request.workspace,
      agentId: request.agent,
      host: 'github.com',
      repository: {
        nodeId: repository.nodeId,
        databaseId: repository.databaseId,
        owner: { login: repository.owner.login, nodeId: repository.owner.nodeId },
        name: repository.name,
      },
      issue: { nodeId: item.nodeId, databaseId: item.databaseId, number: item.number },
      assignment: { ...events[0]!, event: 'assigned', nodeId: event },
      evidence: {
        policyDigest: 'policy',
        mode: 'work',
        open: true,
        assigned: true,
        repositoryReadable: true,
        ownerPinned: true,
        actorPinned: true,
      },
      observedAt: 1,
      admittedAt: 1,
      status: 'admitted',
      requiresRevalidation: true,
    });
    const first = admission('E_old'),
      second = admission('E_new');
    const intake: IntakeState = {
      version: 1,
      scope: location.scope,
      workspaceDir: request.workspace,
      agentId: request.agent,
      account: { login: account.login, nodeId: account.nodeId },
      policyDigest: 'policy',
      baselineAt: 1,
      records: [first, second],
      observedAssignments: [],
    };
    await writeFile(location.path, JSON.stringify(intake), { mode: 0o600 });
    const retired: SharedDispatchRecord = {
      id: 'a'.repeat(64),
      intakeId: first.id,
      issueKey: 'd'.repeat(64),
      sourceThreadId: 'coordinator',
      phase: 'routing',
      createdAt: 1,
      manifestDigest: 'manifest',
      context: 'old copied plan',
      threadId: 'old-thread',
      worktree: '/fixture/old-checkout',
      retired: { at: 30, by: 'coordinator' },
      nativeInactive: true,
      retirement: {
        reason: 'operator-requested',
        at: 10,
        checkedAt: 30,
        eligibleAt: 10,
        intakeId: first.id,
        archivedAt: 20,
        worktreeRemovedAt: 25,
      },
    };
    const active: SharedDispatchRecord = {
      id: 'b'.repeat(64),
      intakeId: second.id,
      issueKey: retired.issueKey,
      sourceThreadId: 'coordinator',
      phase: 'routing',
      createdAt: 35,
      manifestDigest: 'manifest',
      context: 'active plan',
      threadId: 'active-thread',
      worktree: '/fixture/active-checkout',
      implementationDecision: undefined,
    };
    if (runtime === 'openclaw')
      Object.assign(retired, {
        sessionCreation: {
          attempted: true,
          sourceSessionId: 'coordinator-session',
          sourceRunId: 'run',
          sourceToolCallId: 'call',
          sessionId: 'incarnation',
          verified: true,
        },
      });
    const Store = runtime === 'codex' ? CodexDispatchStore : OpenClawDispatchStore;
    const store: DispatchStore<SharedDispatchRecord> = new Store(dispatchRoot, location.scope);
    const state = {
      version: 1,
      scope: location.scope,
      resetGeneration: 'initial',
      records: [retired, active],
    };
    // the capsule contains the real retired-session identity without requiring native access.
    state.records[0] = retainDispatchHistory(retired)!;
    const reference = await store.history.exclusive(() => store.history.retain(retired, 30, 30));
    state.records[0]!.retainedHistory!.entries.push(reference);
    await writeFile(store.path, JSON.stringify(state), { mode: 0o600 });
    await writeFile(join(dispatchRoot, 'unrelated.json'), '{"keep":"unchanged"}\n', {
      mode: 0o600,
    });
    return {
      request,
      store,
      retired,
      active: JSON.parse(JSON.stringify(active)) as SharedDispatchRecord,
      location,
      intake,
      state,
    };
  }

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should consume old events and remove only completed task copies in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const original = await readFile(f.store.path);
      const result = await cutover638(f.request);
      assert.deepEqual(result.removed, [f.retired.id]);
      assert.equal(result.retained, 1);
      assert.deepEqual(await readFile(f.store.path), original);
      const dispatchRoot = join(result.output, runtime === 'codex' ? 'state' : 'dispatch');
      const Store = runtime === 'codex' ? CodexDispatchStore : OpenClawDispatchStore;
      const migrated = new Store(dispatchRoot, f.location.scope);
      assert.deepEqual((await migrated.read()).records, [f.active]);
      assert.equal(
        (await readdir(migrated.history.directory)).filter((name) => name.endsWith('.json')).length,
        0,
      );
      const intakeRoot = join(result.output, runtime === 'codex' ? 'state' : 'intake');
      const intake = await new IntakeRecordStore({
        ...f.location,
        root: intakeRoot,
        path: join(intakeRoot, `github-intake-${f.location.scope}.json`),
        resetRoot: dispatchRoot,
      }).read();
      assert.equal(
        intake?.observedAssignments?.find((x) => x.id === f.retired.intakeId)?.consumedBy,
        f.retired.id,
      );
      assert.equal(
        intake?.observedAssignments?.find((x) => x.id === f.active.intakeId)?.consumedBy,
        f.active.id,
      );
      assert.equal(
        await readFile(join(dispatchRoot, 'unrelated.json'), 'utf8'),
        '{"keep":"unchanged"}\n',
      );
      const second = await cutover638({
        ...f.request,
        source: result.output,
        output: join(root, 'second'),
      });
      assert.deepEqual(second.changes, []);
      assert.deepEqual(second.removed, []);
    });
  }

  it('should preserve an existing assignment consumer', async () => {
    const f = await fixture('codex');
    const r = f.intake.records[0]!;
    const observation = omit(r, ['evidence', 'admittedAt', 'status', 'requiresRevalidation']);
    f.intake.observedAssignments = [{ ...observation, consumedBy: 'c'.repeat(64) }];
    await writeFile(f.location.path, JSON.stringify(f.intake));
    await cutover638(f.request);
    const next = JSON.parse(
      await readFile(
        join(f.request.output, 'state', `github-intake-${f.location.scope}.json`),
        'utf8',
      ),
    ) as IntakeState;
    assert.equal(next.observedAssignments![0]!.consumedBy, 'c'.repeat(64));
  });

  it('should preserve two independent manual attempts without inventing assignment events', async () => {
    const f = await fixture('codex');
    const intake = omit(f.intake.records[0]!, ['assignment', 'evidence']);
    const manual = ['c', 'e'].map((letter) => {
      const id = letter.repeat(64);
      const manualIssue = {
        ...intake,
        id,
        fresh: true as const,
        initiation: {
          kind: 'operator' as const,
          session: 'operator',
          incarnation: 'operator',
          turn: letter,
          input: letter,
        },
        evidence: {
          policyDigest: 'policy',
          mode: 'work' as const,
          open: true as const,
          repositoryReadable: true as const,
        },
      };
      return {
        ...omit(f.active, ['intakeId']),
        id,
        manualIssue,
        sourceThreadId: 'operator',
        issueKey: automationHash([
          intake.scope,
          intake.receiving.nodeId,
          intake.repository.nodeId,
          intake.issue.nodeId,
        ]),
        threadId: 'manual-' + letter,
        worktree: '/fixture/manual-' + letter,
      };
    });
    f.state.records.push(...manual);
    await writeFile(f.store.path, JSON.stringify(f.state));
    const result = await cutover638(f.request);
    const migrated = await new CodexDispatchStore(
      join(result.output, 'state'),
      f.location.scope,
    ).read();
    assert.deepEqual(migrated.records, [f.active, ...manual]);
    const next = JSON.parse(
      await readFile(
        join(result.output, 'state', `github-intake-${f.location.scope}.json`),
        'utf8',
      ),
    ) as IntakeState;
    assert.equal(next.observedAssignments!.length, 2);
  });

  it('should recover exact uncertain delivery from a terminal snapshot and retain only its operation', async () => {
    const f = await fixture('codex');
    const delivery: CodexDeliveryState = {
      id: 'f'.repeat(64),
      binding: {
        repositoryId: f.intake.records[0]!.repository.nodeId,
        issueId: f.intake.records[0]!.issue.nodeId,
        threadId: 'old-thread',
        worktree: '/fixture/old-checkout',
        branch: 'old-branch',
        base: 'main',
        head: 'a'.repeat(40),
        authorId: account.nodeId,
        policyDigest: 'e'.repeat(64),
      },
      creationAttempted: true,
      reconciled: false,
      attached: false,
      cardAttempts: 0,
    };
    const original = { ...f.retired, delivery };
    const capsule = retainDispatchHistory(original)!;
    const reference = await f.store.history.exclusive(() =>
      f.store.history.retain(original, 30, 30),
    );
    capsule.retainedHistory!.entries.push(reference);
    f.state.records[0] = capsule;
    await writeFile(f.store.path, JSON.stringify(f.state));
    const result = await cutover638(f.request);
    assert.equal(result.uncertainEffects, 1);
    const migrated = await new CodexDispatchStore(
      join(result.output, 'state'),
      f.location.scope,
    ).read();
    const effect = migrated.retirementEffects![0]!;
    assert.equal(effect.kind, 'delivery');
    assert.equal(effect.creationAttempted, true);
    const publication = JSON.parse(effect.publication);
    assert.equal(publication.branch, 'old-branch');
    assert.equal(publication.headSha, 'a'.repeat(40));
    assert.ok(!JSON.stringify(migrated).includes('old copied plan'));
    const second = await cutover638({
      ...f.request,
      source: result.output,
      output: join(root, 'second'),
    });
    assert.deepEqual(second.changes, []);
    assert.equal(second.uncertainEffects, 1);
  });

  it('should preserve grace and reduce already-started cleanup without removing native resources', async () => {
    const f = await fixture('codex');
    const record = f.state.records[0]!;
    delete record.retired;
    delete record.retainedHistory;
    delete record.retirement!.worktreeRemovedAt;
    record.context = 'obsolete copied plan';
    const grace = {
      ...f.active,
      retirement: {
        reason: 'operator-requested' as const,
        at: 40,
        checkedAt: 40,
        eligibleAt: 100,
        intakeId: f.active.intakeId!,
      },
    };
    f.state.records[1] = grace;
    await writeFile(f.store.path, JSON.stringify(f.state));
    const result = await cutover638(f.request);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.pending, [record.id]);
    const migrated = await new CodexDispatchStore(
      join(result.output, 'state'),
      f.location.scope,
    ).read();
    assert.equal(migrated.records[0]!.cleanupPending, true);
    assert.equal(migrated.records[0]!.context, undefined);
    assert.deepEqual(migrated.records[0]!.retirement, record.retirement);
    assert.deepEqual(migrated.records[1], grace);
  });

  it('should refuse unknown assignment evidence without producing a replacement', async () => {
    const f = await fixture('codex');
    f.intake.records.splice(0, 1);
    await writeFile(f.location.path, JSON.stringify(f.intake));
    await assert.rejects(cutover638(f.request), /cutover-assignment-unresolved/);
    assert.ok(!(await readdir(root)).includes('output'));
  });

  it('should refuse unresolved capsule effects without their exact original request', async () => {
    const f = await fixture('codex');
    f.state.records[0]!.retainedHistory!.effects = [
      { kind: 'delivery', id: 'effect', status: 'uncertain' },
    ];
    f.state.records[0]!.retainedHistory!.entries = [];
    await writeFile(f.store.path, JSON.stringify(f.state));
    await assert.rejects(cutover638(f.request), /cutover-unresolved-history/);
    assert.ok(!(await readdir(root)).includes('output'));
    assert.equal((await f.store.read()).records.length, 2);
  });

  it('should reject output reuse, nested outputs, symbolic links and unsettled lock files', async () => {
    const f = await fixture('codex');
    await assert.rejects(
      cutover638({ ...f.request, output: f.request.source }),
      /cutover-path-overlap/,
    );
    await mkdir(f.request.output);
    await writeFile(join(f.request.output, 'keep'), 'do not touch');
    await assert.rejects(cutover638(f.request), /EEXIST/);
    assert.equal(await readFile(join(f.request.output, 'keep'), 'utf8'), 'do not touch');
    await symlink(f.store.path, join(f.request.source, 'link'));
    await assert.rejects(cutover638(f.request), /cutover-unsafe-file/);
    await rm(join(f.request.source, 'link'));
    await mkdir(join(f.request.source, 'writer.lock'));
    await assert.rejects(cutover638(f.request), /cutover-unsettled-file/);
  });
});
