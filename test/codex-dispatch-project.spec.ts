import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  githubOrigin,
  resolveDispatchProject,
  verifyDispatchWorktree,
  type DispatchGit,
} from '../agent/codex-dispatch-project.ts';

describe('agent/codex-dispatch-project', () => {
  let root: string, source: string, other: string, commonDir: string;
  let git: DispatchGit;
  const commit = '1'.repeat(40);
  const project = (path: string) => ({
    path,
    projectId: path,
    projectKind: 'local',
    hostId: 'local',
    isGitRepository: true,
  });
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex-project-')));
    source = join(root, 'source');
    other = join(root, 'other');
    commonDir = join(root, 'common');
    for (const path of [source, other, commonDir]) await mkdir(path);
    git = async (_cwd, argv) => {
      if (argv.length === 1 && argv[0] === 'remote') return 'origin';
      if (argv[0] === 'remote') return 'https://github.com/owner/repo.git';
      if (argv.includes('--git-common-dir')) return commonDir;
      if (argv[0] === 'rev-parse') return commit;
      return '';
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should require exact repository identity and use explicit paths only to constrain saved projects', async () => {
    const input = {
      projects: [project(source), project(other)],
      repository: 'owner/repo',
      defaultBranch: 'main',
      workspace: root,
    };
    await assert.rejects(resolveDispatchProject(input, git), /dispatch-project-ambiguous/);
    const selected = await resolveDispatchProject({ ...input, explicitPath: './source' }, git);
    assert.equal(selected.path, source);
    assert.equal(selected.commit, commit);
    assert.equal(selected.ref, 'refs/remotes/origin/main');
    await assert.rejects(
      resolveDispatchProject({ ...input, projects: [project(other)], explicitPath: source }, git),
      /dispatch-project-missing/,
    );
    assert.equal(githubOrigin('git@github.com:Owner/Repo.git'), 'owner/repo');
    assert.equal(githubOrigin('https://github.com.evil/owner/repo'), undefined);
    assert.equal(githubOrigin('https://github.com/owner/repo/extra'), undefined);
  });

  it('should reject unsafe refs and changed or unrelated assessment worktrees', async () => {
    const input = {
      projects: [project(source)],
      repository: 'owner/repo',
      defaultBranch: 'main',
      workspace: root,
    };
    await assert.rejects(
      resolveDispatchProject({ ...input, defaultBranch: '--upload-pack=bad' }, git),
      /dispatch-starting-ref-invalid/,
    );
    const selected = await resolveDispatchProject(input, git);
    assert.equal(await verifyDispatchWorktree(selected, other, 'owner/repo', git), other);
    await assert.rejects(
      verifyDispatchWorktree(selected, source, 'owner/repo', git),
      /dispatch-worktree-required/,
    );
    await assert.rejects(
      verifyDispatchWorktree(selected, other, 'owner/repo', async (cwd, argv) =>
        argv[0] === 'status' ? ' M file.ts' : git(cwd, argv),
      ),
      /dispatch-assessment-worktree-changed/,
    );
    await assert.rejects(
      verifyDispatchWorktree(selected, other, 'owner/repo', async (cwd, argv) =>
        argv.includes('HEAD') ? '2'.repeat(40) : git(cwd, argv),
      ),
      /dispatch-worktree-diverged/,
    );
    await assert.rejects(
      verifyDispatchWorktree(selected, other, 'owner/repo', async (cwd, argv) =>
        argv.includes('--git-common-dir') ? other : git(cwd, argv),
      ),
      /dispatch-worktree-diverged/,
    );
  });

  it('should skip projects without origin while retaining inventory failure checks', async () => {
    const input = {
      projects: [project(other), project(source)],
      repository: 'owner/repo',
      defaultBranch: 'main',
      workspace: root,
    };
    const withoutOrigin: DispatchGit = async (cwd, argv) => {
      if (cwd === other && argv[0] === 'remote') {
        assert.deepEqual(argv, ['remote']);
        return 'upstream';
      }
      return git(cwd, argv);
    };
    assert.equal((await resolveDispatchProject(input, withoutOrigin)).path, source);
    await assert.rejects(
      resolveDispatchProject({ ...input, projects: [project(other)] }, withoutOrigin),
      /dispatch-project-missing/,
    );
    for (const failure of ['list', 'origin']) {
      await assert.rejects(
        resolveDispatchProject(input, async (cwd, argv) => {
          if (cwd === other && argv[0] === 'remote' && (failure === 'list' || argv.length > 1))
            throw new Error('git inspection failed');
          return git(cwd, argv);
        }),
        /dispatch-project-inventory-unavailable/,
      );
    }
  });
});
