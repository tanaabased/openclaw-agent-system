import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchGit } from '../agent/codex-dispatch-project.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import prepareBranch from '../agent/codex-work-branch.ts';

describe('agent/codex-work-branch native git', () => {
  it('should start a new attempt at its pinned base and preserve both retired branches and commits', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-branch-')));
    const source = join(root, 'source'),
      worktree = join(root, 'worktree');
    await mkdir(source);
    const git = (argv: string[]) => dispatchGit(source, argv);
    const commit = () =>
      git([
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ]);
    try {
      await git(['init', '-b', 'main']);
      await commit();
      const base = await git(['rev-parse', 'HEAD']);
      await git(['switch', '-c', 'retired-same-issue']);
      await commit();
      const oldHead = await git(['rev-parse', 'HEAD']);
      await git(['switch', 'main']);
      await git(['worktree', 'add', '--detach', worktree, base]);
      const intake = {
        repository: {
          nodeId: 'R_repo',
          databaseId: 10,
          name: 'repo',
          owner: { login: 'owner', nodeId: 'O_owner' },
        },
        issue: { nodeId: 'I_issue', databaseId: 20, number: 3 },
      };
      const record: DispatchRecord = {
        id: 'a'.repeat(64),
        intakeId: 'b'.repeat(64),
        issueKey: 'c'.repeat(64),
        sourceThreadId: 'intake',
        phase: 'complete',
        createdAt: 1,
        manifestDigest: 'manifest',
        threadId: 'child',
        worktree,
        project: {
          id: 'project',
          path: source,
          commonDir: join(source, '.git'),
          ref: 'refs/remotes/origin/main',
          commit: base,
        },
        context: JSON.stringify({ title: 'Fix the defect' }),
      };
      const input = { record, intake, workspace: root, agentId: 'receiver', save: async () => {} };
      const branch = await prepareBranch(input);
      assert.notEqual(branch, 'retired-same-issue');
      assert.equal(await dispatchGit(worktree, ['rev-parse', 'HEAD']), base);
      assert.equal(await git(['rev-parse', 'retired-same-issue']), oldHead);
      assert.equal(await prepareBranch(input), branch);
      await dispatchGit(worktree, ['switch', 'retired-same-issue']);
      await assert.rejects(prepareBranch(input), /dispatch-branch-owner-mismatch/);
      assert.equal(await dispatchGit(worktree, ['rev-parse', 'HEAD']), oldHead);
      await dispatchGit(worktree, ['switch', branch]);
      await git(['worktree', 'remove', worktree]);
      record.retired = { at: 2, by: 'operator' };
      await git(['worktree', 'add', '--detach', worktree, base]);
      const fresh: DispatchRecord = { ...record, id: 'd'.repeat(64) };
      delete fresh.worktreeAttemptId;
      delete fresh.worktreeBranch;
      delete fresh.retired;
      const freshBranch = await prepareBranch({ ...input, record: fresh });
      assert.notEqual(freshBranch, branch);
      assert.equal(await dispatchGit(worktree, ['rev-parse', 'HEAD']), base);
      assert.equal(await git(['rev-parse', branch]), base);
      assert.equal(await git(['rev-parse', 'retired-same-issue']), oldHead);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
