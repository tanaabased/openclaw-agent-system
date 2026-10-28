import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import codexIssueBranch from '../agent/codex-issue-branch.ts';
import type { DispatchGit } from '../agent/codex-dispatch-project.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';

const execute = promisify(execFile);
// exercise local git mechanics, not the host's managed launcher or credential configuration.
const fixtureGit: DispatchGit = async (cwd, args) =>
  (
    await execute('/usr/bin/git', args, {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
  ).stdout.trim();

describe('agent/codex-issue-branch', () => {
  let root: string, cwd: string, base: string, record: DispatchRecord;
  let records: DispatchRecord[], saved: DispatchRecord[];
  const intake = {
    repository: { nodeId: 'R_repository' },
    issue: { nodeId: 'I_issue', number: 42 },
  } as IntakeRecord;
  async function git(...args: string[]) {
    return fixtureGit(cwd, args);
  }
  const prepare = (extra: Partial<Parameters<typeof codexIssueBranch>[0]> = {}) =>
    codexIssueBranch({
      record,
      records,
      intake,
      workspace: root,
      agentId: 'receiver',
      git: fixtureGit,
      save: async () => {
        saved.push(structuredClone(record));
      },
      prepare: true,
      ...extra,
    });
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex-branch-')));
    cwd = root;
    await git('init', '--initial-branch=main');
    await git('config', 'user.name', 'Fixture');
    await git('config', 'user.email', 'fixture@example.test');
    await git('config', 'commit.gpgsign', 'false');
    await writeFile(join(root, 'work.txt'), 'base');
    await git('add', 'work.txt');
    await git('commit', '-m', 'base');
    base = await git('rev-parse', 'HEAD');
    await git('switch', '--detach');
    record = {
      id: 'a'.repeat(64),
      threadId: 'child',
      worktree: cwd,
      context: JSON.stringify({ title: 'Repair work' }),
      project: {
        id: 'project',
        path: '/primary',
        commonDir: join(root, '.git'),
        ref: 'origin/main',
        commit: base,
      },
    } as DispatchRecord;
    records = [record];
    saved = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should isolate a fresh attempt from preserved retired commits and retry on the same branch', async () => {
    const old = await prepare();
    await writeFile(join(root, 'work.txt'), 'retired work');
    await git('commit', '-am', 'old work');
    const oldHead = await git('rev-parse', 'HEAD');
    record.retired = { at: 1, by: 'operator' };
    await git('switch', '--detach', base);
    const previous = record;
    record = { ...record, id: 'b'.repeat(64), issueBranch: undefined, retired: undefined };
    records = [previous, record];
    const fresh = await prepare();
    assert.notEqual(fresh, old);
    assert.equal(await git('rev-parse', 'HEAD'), base);
    assert.equal(await git('rev-parse', old), oldHead);
    await writeFile(join(root, 'work.txt'), 'fresh work');
    await git('commit', '-am', 'fresh work');
    const freshHead = await git('rev-parse', 'HEAD');
    record = structuredClone(record);
    record.context = JSON.stringify({ title: 'Renamed issue' });
    records = [previous, record];
    assert.equal(await prepare(), fresh);
    assert.equal(await git('rev-parse', 'HEAD'), freshHead);
    assert.equal(
      (await git('for-each-ref', '--format=%(refname)', 'refs/heads')).split('\n').length,
      3,
    );
    assert.equal(saved[0]!.issueBranch?.phase, 'planned');
    assert.equal(saved[1]!.issueBranch?.phase, 'creating');
  });

  it('should recover a lost git response without creating another branch', async () => {
    let interrupted = false;
    await assert.rejects(
      prepare({
        git: async (_path, args) => {
          const result = await git(...args);
          if (args[0] === 'switch') {
            interrupted = true;
            throw new Error('lost response');
          }
          return result;
        },
      }),
      /lost response/,
    );
    assert.ok(interrupted);
    assert.equal(record.issueBranch?.phase, 'creating');
    record = structuredClone(saved.at(-1)!);
    records = [record];
    const branch = await prepare();
    assert.equal(await git('branch', '--show-current'), branch);
    assert.equal(record.issueBranch?.phase, 'ready');
  });

  it('should continue a fetched pr head on a distinct local branch while preserving occupied unpublished work', async () => {
    await git('switch', '-c', 'shared-pr');
    await writeFile(join(root, 'work.txt'), 'published PR work');
    await git('commit', '-am', 'published work');
    const published = await git('rev-parse', 'HEAD');
    const fetchedRef = 'refs/agent-system/pr/fixture';
    await git('fetch', '--no-tags', root, `refs/heads/shared-pr:${fetchedRef}`);
    await git('switch', '--detach', published);
    const oldPath = join(root, '.git', 'old-checkout');
    await git('worktree', 'add', oldPath, 'shared-pr');
    await writeFile(join(oldPath, 'work.txt'), 'unpublished predecessor work');
    await fixtureGit(oldPath, ['commit', '-am', 'unpublished work']);
    const oldHead = await fixtureGit(oldPath, ['rev-parse', 'HEAD']);
    const previous = {
      ...record,
      worktree: oldPath,
      issueBranch: { attemptId: record.id, name: 'shared-pr', phase: 'ready' as const },
    };
    record = {
      ...record,
      id: 'b'.repeat(64),
      project: { ...record.project!, commit: await git('rev-parse', fetchedRef) },
    };
    records = [previous, record];
    const local = await prepare();
    assert.notEqual(local, 'shared-pr');
    assert.equal(await git('rev-parse', 'HEAD'), published);
    assert.equal(await git('rev-parse', 'shared-pr'), oldHead);
    assert.equal(
      await fixtureGit(oldPath, ['show', 'HEAD:work.txt']),
      'unpublished predecessor work',
    );
    record.delivery = {
      localBranch: local,
      pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
      binding: {
        repositoryId: intake.repository.nodeId,
        issueId: intake.issue.nodeId,
        threadId: record.threadId!,
        worktree: cwd,
        branch: 'shared-pr',
      },
    } as NonNullable<DispatchRecord['delivery']>;
    delete record.issueBranch;
    assert.equal(await prepare({ prepare: false }), local);
    assert.equal(await git('rev-parse', 'shared-pr'), oldHead);
  });

  it('should recover a created ref before checkout from the retained base', async () => {
    await assert.rejects(
      prepare({
        git: async (_path, args) => {
          if (args[0] === 'switch') {
            await git('branch', args[2]!, args[3]!);
            throw new Error('before checkout');
          }
          return git(...args);
        },
      }),
      /before checkout/,
    );
    assert.equal(await git('branch', '--show-current'), '');
    const branch = await prepare();
    assert.equal(await git('branch', '--show-current'), branch);
    assert.equal(await git('rev-parse', 'HEAD'), base);
  });

  it('should reject another branch without changing files or refs', async () => {
    const owned = await prepare();
    await git('switch', '-c', '42-historical-branch');
    await writeFile(join(root, 'work.txt'), 'preserve me');
    await assert.rejects(prepare(), /codex-branch-owner-mismatch/);
    await assert.rejects(prepare({ prepare: false }), /codex-branch-owner-mismatch/);
    assert.equal(await git('branch', '--show-current'), '42-historical-branch');
    assert.match(await git('diff'), /preserve me/);
    assert.equal(await git('rev-parse', owned), base);
  });

  it('should refuse an occupied planned ref or another worktree without forcing it', async () => {
    await assert.rejects(
      prepare({
        git: async (_path, args) => {
          if (args[0] === 'for-each-ref') {
            await git('branch', record.issueBranch!.name, base);
          }
          return git(...args);
        },
      }),
      /codex-branch-ref-occupied/,
    );
    assert.equal(await git('branch', '--show-current'), '');
    record.issueBranch!.phase = 'creating';
    await git('worktree', 'add', join(root, 'other'), record.issueBranch!.name);
    await assert.rejects(prepare());
    assert.equal(await git('branch', '--show-current'), '');
    assert.equal(await git('rev-parse', record.issueBranch!.name), base);
  });

  it('should preserve legacy authored work without adopting its issue-shaped branch', async () => {
    await git('switch', '-c', '42-old-branch');
    await writeFile(join(root, 'work.txt'), 'old work');
    await git('commit', '-am', 'old work');
    const head = await git('rev-parse', 'HEAD');
    await assert.rejects(prepare(), /codex-branch-owner-required/);
    assert.equal(record.issueBranch, undefined);
    assert.equal(await git('rev-parse', 'HEAD'), head);
  });

  it('should retain only an exact legacy delivery owner and reject conflicting retired ownership', async () => {
    await git('switch', '-c', 'legacy-delivery');
    record.delivery = {
      binding: {
        repositoryId: 'R_repository',
        issueId: 'I_issue',
        threadId: 'wrong',
        worktree: cwd,
        branch: 'legacy-delivery',
      },
    } as NonNullable<DispatchRecord['delivery']>;
    await assert.rejects(prepare(), /codex-branch-owner-required/);
    record.delivery.pullRequest = { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 };
    await assert.rejects(prepare(), /codex-branch-owner-required/);
    record.delivery.binding.threadId = record.threadId!;
    assert.equal(await prepare({ prepare: false }), 'legacy-delivery');
    records.push({
      ...record,
      id: 'b'.repeat(64),
      issueBranch: { attemptId: 'b'.repeat(64), name: 'legacy-delivery', phase: 'ready' },
      retired: { at: 1, by: 'operator' },
    });
    await assert.rejects(prepare(), /codex-branch-owner-mismatch/);
  });
});
