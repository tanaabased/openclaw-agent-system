import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import cleanup from '../agent/codex-retirement-cleanup.ts';
import nativeRetirement from '../agent/codex-retirement-native.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';

describe('codex retirement cleanup', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex-retirement-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const worktree = join(root, 'worktrees', 'abc', 'repo');
    await mkdir(worktree, { recursive: true });
    const record = {
      id: 'r',
      intakeId: 'i',
      issueKey: 'k',
      sourceThreadId: 'owner',
      phase: 'complete',
      createdAt: 1,
      manifestDigest: 'd',
      threadId: 'child',
      worktree,
      project: { id: 'p', path: root, commonDir: root, ref: 'main', commit: '1'.repeat(40) },
      retirement: { reason: 'issue-closed', at: 10, checkedAt: 10, eligibleAt: 20, intakeId: 'i' },
    } satisfies DispatchRecord;
    const calls: string[][] = [];
    let fresh = 0;
    let saved = 0;
    const input: Parameters<typeof cleanup>[0] = {
      record,
      codexHome: root,
      repository: 'owner/repo',
      archived: false,
      now: 30,
      turnId: 'turn',
      inventory: {
        schemaVersion: 4,
        pinnedThreads: [],
        unavailableHosts: [],
        unavailableSources: [],
      },
      native: { worktreeUsers: async () => ['child'], archiveOutcome: async () => 'unverified' },
      git: async (_path, args) => {
        calls.push(args);
        if (args[0] === 'remote') return 'https://github.com/owner/repo.git';
        if (args.includes('--git-common-dir')) return root;
        if (args[0] === 'rev-parse') return '1'.repeat(40);
        if (args[0] === 'for-each-ref') return 'refs/heads/saved';
        return '';
      },
      fresh: async () => {
        fresh++;
      },
      save: async () => {
        saved++;
      },
    };
    return { input, calls, fresh: () => fresh, saved: () => saved, run: () => cleanup(input) };
  }
  it('should prepare exactly one native archive and retain uncertainty without deleting the worktree', async () => {
    const h = await fixture();
    const result = await h.run();
    assert.ok('request' in result);
    assert.deepEqual(result.request, { threadId: 'child', hostId: 'local', archived: true });
    assert.equal(h.fresh(), 1);
    assert.equal(h.saved(), 1);
    assert.equal((await h.run()).code, 'retirement-native-archive-unverified');
    assert.equal(
      h.calls.some((args) => args.includes('remove')),
      false,
    );
    h.input.archived = true;
    assert.equal((await h.run()).code, 'retirement-native-reclamation-pending');
    await rm(h.input.record.worktree!, { recursive: true });
    assert.deepEqual(await h.run(), { archived: true, worktreeRemoved: true });
  });
  it('should permit verified retiring peers while protecting pinned or unowned peers', async () => {
    const h = await fixture();
    h.input.shared = [{ ...h.input.record, id: 'peer', threadId: 'peer' }];
    h.input.native.worktreeUsers = async () => ['child', 'peer'];
    h.input.inventory = { ...(h.input.inventory as object), pinnedThreads: [{ id: 'peer' }] };
    assert.equal((await h.run()).code, 'retirement-native-resource-protected');
    h.input.inventory = { ...(h.input.inventory as object), pinnedThreads: [] };
    h.input.native.worktreeUsers = async () => ['child', 'peer', 'unowned'];
    assert.equal((await h.run()).code, 'retirement-worktree-shared');
    h.input.native.worktreeUsers = async () => ['child', 'peer'];
    assert.ok((await h.run()).request);
  });
  it('should retry only a natively proved unsubmitted archive', async () => {
    const h = await fixture();
    await h.run();
    h.input.native.archiveOutcome = async () => 'unsubmitted';
    h.input.turnId = 'next-turn';
    assert.ok('request' in (await h.run()));
    assert.equal(h.input.record.retirement!.archiveAttempt?.turnId, 'next-turn');
  });
  it('should allow a completed guardian but preserve pinned and automation-owned helpers', async () => {
    const h = await fixture();
    const guardian = {
      id: 'guardian',
      cwd: h.input.record.worktree,
      source: { subAgent: { other: 'guardian' } },
    };
    h.input.native = nativeRetirement(async (method) => {
      if (method === 'thread/list') return { data: [guardian] };
      if (method === 'thread/read')
        return {
          thread: {
            ...guardian,
            parentThreadId: 'child',
            threadSource: 'guardian_review',
            status: { type: 'notLoaded' },
          },
        };
      return { data: [{ status: 'completed', completedAt: 10 }] };
    });
    h.input.inventory = { ...(h.input.inventory as object), pinnedThreads: [{ id: 'guardian' }] };
    assert.equal((await h.run()).code, 'retirement-worktree-shared');
    h.input.inventory = { ...(h.input.inventory as object), pinnedThreads: [] };
    const job = join(root, 'automations', 'job');
    await mkdir(job, { recursive: true });
    await writeFile(
      join(job, 'automation.toml'),
      [
        'version = 1',
        'id = "job"',
        'name = "test"',
        'prompt = "test"',
        'status = "PAUSED"',
        'kind = "heartbeat"',
        'rrule = "FREQ=MINUTELY;INTERVAL=5"',
        'target_thread_id = "guardian"',
        'created_at = 1',
        'updated_at = 1',
      ].join('\n'),
    );
    assert.equal((await h.run()).code, 'retirement-worktree-shared');
    await rm(job, { recursive: true });
    assert.deepEqual((await h.run()).request, {
      threadId: 'child',
      archived: true,
      hostId: 'local',
    });
  });
  for (const kind of [
    'pinned',
    'shared',
    'dirty',
    'unpreserved',
    'inventory',
    'automation',
  ] as const) {
    it(`should preserve ${kind} resources without issuing an archive`, async () => {
      const h = await fixture();
      const git = h.input.git!;
      if (kind === 'pinned')
        h.input.inventory = { ...(h.input.inventory as object), pinnedThreads: [{ id: 'child' }] };
      if (kind === 'shared') h.input.native.worktreeUsers = async () => ['child', 'other'];
      if (kind === 'dirty')
        h.input.git = async (path, args) =>
          args[0] === 'status' ? '?? notes.md' : git(path, args);
      if (kind === 'unpreserved')
        h.input.git = async (path, args) => (args[0] === 'for-each-ref' ? '' : git(path, args));
      if (kind === 'inventory') h.input.inventory = {};
      if (kind === 'automation') {
        await mkdir(join(root, 'automations', 'job'), { recursive: true });
        await writeFile(
          join(root, 'automations', 'job', 'automation.toml'),
          [
            'version = 1',
            'id = "job"',
            'name = "test"',
            'prompt = "test"',
            'status = "PAUSED"',
            'kind = "heartbeat"',
            'rrule = "FREQ=MINUTELY;INTERVAL=5"',
            'target_thread_id = "child"',
            'created_at = 1',
            'updated_at = 1',
          ].join('\n'),
        );
      }
      const result = await h.run();
      assert.equal('request' in result, false);
      assert.equal(result.worktreeRemoved, false);
      assert.equal(h.input.record.retirement!.archiveAttempt, undefined);
      assert.equal(h.fresh(), 0);
    });
  }
  it('should allow local cleanup despite unavailable remote hosts and chatgpt', async () => {
    const h = await fixture();
    h.input.inventory = {
      ...(h.input.inventory as object),
      unavailableHosts: ['offline-remote'],
      unavailableSources: ['chatgpt'],
    };
    assert.ok((await h.run()).request);
  });
  it('should accept a verified checkout outside the default codex worktree root', async () => {
    const h = await fixture();
    h.input.codexHome = join(root, 'custom-home');
    await mkdir(h.input.codexHome);
    assert.ok((await h.run()).request);
  });
  for (const unavailable of [{ unavailableHosts: ['local'] }, { unavailableSources: ['codex'] }]) {
    it('should still require an available local codex inventory', async () => {
      const h = await fixture();
      h.input.inventory = { ...(h.input.inventory as object), ...unavailable };
      assert.equal((await h.run()).code, 'retirement-native-inventory-required');
      assert.equal(h.saved(), 0);
    });
  }
  it('should report a confirmed denial without preparing another archive', async () => {
    const h = await fixture();
    await h.run();
    h.input.native.archiveOutcome = async () => 'denied';
    for (let poll = 0; poll < 2; poll++) {
      const result = await h.run();
      assert.equal(result.code, 'retirement-native-archive-denied');
      assert.equal(result.request, undefined);
    }
    assert.equal(h.saved(), 1);
    assert.ok(h.input.record.retirement!.archiveAttempt);
  });
  it('should not treat a missing checkout as native archive evidence', async () => {
    const h = await fixture();
    await rm(h.input.record.worktree!, { recursive: true });
    assert.equal((await h.run()).code, 'retirement-worktree-observation-required');
  });
});
