import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  githubOrigin,
  resolveDispatchProject,
  verifyDispatchWorktree,
  type DispatchGit,
} from '../agent/codex-dispatch-project.ts';
import codexHostAccess from '../agent/codex-host-access.ts';

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
      if (argv.includes('--is-bare-repository')) return 'false';
      if (argv.includes('--show-toplevel')) return _cwd;
      if (argv[0] === 'rev-parse') return commit;
      return '';
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should preserve permission errors from configured and discovered project paths', async function () {
    if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
    const parent = join(root, 'restricted');
    const path = join(parent, 'repo');
    await mkdir(path, { recursive: true });
    await chmod(parent, 0);
    try {
      for (const explicitPath of [undefined, path])
        await assert.rejects(
          resolveDispatchProject(
            {
              projects: [project(path)],
              repository: 'owner/repo',
              defaultBranch: 'main',
              workspace: root,
              explicitPath,
            },
            git,
          ),
          (error: unknown) => codexHostAccess(error),
        );
    } finally {
      await chmod(parent, 0o700);
    }
  });

  it('should exclude inaccessible unrelated projects when an explicit checkout is configured', async function () {
    if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
    const parent = join(root, 'restricted');
    const path = join(parent, 'repo');
    await mkdir(path, { recursive: true });
    await chmod(parent, 0);
    try {
      for (const projects of [
        [project(path), project(source)],
        [project(source), project(path)],
      ]) {
        const selected = await resolveDispatchProject(
          {
            projects,
            repository: 'owner/repo',
            defaultBranch: 'main',
            workspace: root,
            explicitPath: './source',
          },
          git,
        );
        assert.equal(selected.path, source);
        assert.equal(selected.commit, commit);
      }
    } finally {
      await chmod(parent, 0o700);
    }
  });

  it('should preserve git access denials while classifying other lookup failures', async () => {
    const input = {
      projects: [project(source)],
      repository: 'owner/repo',
      defaultBranch: 'main',
      workspace: root,
    };
    for (const code of ['EPERM', 'EACCES']) {
      const denial = Object.assign(new Error('denied'), { code });
      await assert.rejects(
        resolveDispatchProject(input, async () => {
          throw denial;
        }),
        (error: unknown) => error === denial,
      );
    }
    await assert.rejects(
      resolveDispatchProject(input, async () => {
        throw new Error('failed');
      }),
      /dispatch-project-inventory-unavailable/,
    );
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
    const alias = join(root, 'alias');
    await symlink(source, alias);
    await assert.rejects(
      resolveDispatchProject({ ...input, explicitPath: alias }, git),
      /dispatch-project-path-unsafe/,
    );
  });

  it('should retain changed implementation work at handoff while still requiring repository ownership', async () => {
    const selected = await resolveDispatchProject(
      {
        projects: [project(source)],
        repository: 'owner/repo',
        defaultBranch: 'main',
        workspace: root,
      },
      git,
    );
    const changed: DispatchGit = async (cwd, argv) =>
      argv.includes('HEAD')
        ? '2'.repeat(40)
        : argv[0] === 'status'
          ? ' M implementation.ts'
          : git(cwd, argv);
    assert.equal(
      await verifyDispatchWorktree(selected, other, 'owner/repo', changed, 'handoff'),
      other,
    );
    await assert.rejects(
      verifyDispatchWorktree(
        selected,
        other,
        'owner/repo',
        async (cwd, argv) => (argv.includes('--git-common-dir') ? other : changed(cwd, argv)),
        'handoff',
      ),
      /dispatch-worktree-diverged/,
    );
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
