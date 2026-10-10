import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitWorktreeGitRunner } from '../tools/git/worktree-service.ts';
import resolveGitWorktreeLayout from '../tools/git/worktree-layout.ts';

interface FakeRepository {
  origin: string;
  bare: boolean;
  common?: string;
  id?: string;
  worktrees?: string[];
}

export class RepositoryGit implements GitWorktreeGitRunner {
  readonly calls: Array<{ cwd: string; argv: string[] }> = [];
  beforeClone?: () => Promise<void>;
  failClone = false;
  commit = '1'.repeat(40);
  async seed(
    path: string,
    origin = 'https://github.com/owner/repo.git',
    bare = false,
    common?: string,
  ) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(path, '.fake-git.json'), JSON.stringify({ origin, bare, common }));
  }
  async run(input: { cwd: string; argv: string[]; signal?: AbortSignal }) {
    input.signal?.throwIfAborted();
    const { cwd, argv } = input;
    this.calls.push({ cwd, argv });
    const ok = (stdout = '') => ({ exitCode: 0, stderr: '', stdout });
    if (argv[0] === 'clone') {
      await this.beforeClone?.();
      if (this.failClone) return { exitCode: 1, stderr: 'repository not found', stdout: '' };
      await this.seed(argv.at(-1)!, argv.at(-2)!, argv.includes('--bare'));
      return ok();
    }
    let repo: FakeRepository;
    try {
      repo = JSON.parse(await readFile(join(cwd, '.fake-git.json'), 'utf8')) as FakeRepository;
    } catch {
      return { exitCode: 1, stderr: 'not a repository', stdout: '' };
    }
    if (argv[0] === 'remote') return ok(argv.length === 1 ? 'origin' : repo.origin);
    if (argv[0] === 'rev-parse') {
      if (argv.includes('--is-bare-repository')) return ok(String(repo.bare));
      if (argv.includes('--show-toplevel')) return ok(cwd);
      if (argv.includes('--git-common-dir')) return ok(repo.common ?? cwd);
      return ok(this.commit);
    }
    if (argv[0] === 'config') {
      if (argv.includes('--get')) return ok(repo.id);
      repo.id = argv.at(-1);
      await writeFile(join(cwd, '.fake-git.json'), JSON.stringify(repo));
      return ok();
    }
    if (argv[0] === 'worktree') {
      if (argv[1] === 'list')
        return ok(
          (repo.worktrees ?? []).map((path) => 'worktree ' + path + '\ndetached\n').join('\n'),
        );
      if (argv[1] === 'add') {
        const path = argv.at(-2)!;
        await this.seed(path, repo.origin, false, cwd);
        repo.worktrees = [...(repo.worktrees ?? []), path];
        await writeFile(join(cwd, '.fake-git.json'), JSON.stringify(repo));
        return ok();
      }
    }
    if (['fetch', 'check-ref-format', 'status'].includes(argv[0]!)) return ok();
    throw new Error('unexpected fake git command: ' + argv.join(' '));
  }
  async execute(cwd: string, argv: string[], signal?: AbortSignal) {
    const result = await this.run({ cwd, argv, signal });
    if (result.exitCode !== 0) throw new Error('dispatch-project-git-unavailable');
    return result.stdout;
  }
}

export async function repositoryFixture() {
  const workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'repository-preparation-')));
  const configuration = { repositories: { workingDirectory: 'checkouts' } };
  const layout = resolveGitWorktreeLayout(workspaceDir, configuration);
  await mkdir(layout.repositoryRoot, { mode: 0o700, recursive: true });
  const git = new RepositoryGit();
  return {
    workspaceDir,
    configuration,
    layout,
    git,
    context: { workspaceDir, configuration, git },
  };
}
