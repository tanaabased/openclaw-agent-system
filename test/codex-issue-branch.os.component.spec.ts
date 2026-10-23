import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import codexIssueBranch from '../agent/codex-issue-branch.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';

const execute = promisify(execFile);

describe('agent/codex-issue-branch', () => {
  let root: string, cwd: string, base: string, record: DispatchRecord;
  let records: DispatchRecord[], saved: DispatchRecord[];
  const intake = {
    repository: { nodeId: 'R_repository' },
    issue: { nodeId: 'I_issue', number: 42 },
  } as IntakeRecord;
  async function git(...args: string[]) {
    return (await execute('git', args, { cwd })).stdout.trim();
  }
  const prepare = (extra: Partial<Parameters<typeof codexIssueBranch>[0]> = {}) =>
    codexIssueBranch({
      record,
      records,
      intake,
      workspace: root,
      agentId: 'receiver',
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
