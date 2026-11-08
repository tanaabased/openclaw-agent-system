import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import publishIssueDelivery from '../agent/publish-issue-delivery.ts';

const execute = promisify(execFile);

describe('shared delivery branch tracking', () => {
  for (const mode of ['default push', 'native push', 'already published'])
    it(`should repair inherited base tracking with ${mode}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'delivery-tracking-'));
      const cwd = join(root, 'checkout');
      const remote = join(root, 'remote.git');
      const origin = 'https://github.com/owner/repo.git';
      const git = async (argv: string[]) => {
        // fake provider identity; real git transport stays inside this disposable fixture.
        if (argv[0] === 'remote' && argv[1] === 'get-url') return origin;
        return (
          await execute('/usr/bin/git', argv, {
            cwd,
            env: {
              PATH: '/usr/bin:/bin',
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_ALLOW_PROTOCOL: 'file',
              GIT_TERMINAL_PROMPT: '0',
              GIT_AUTHOR_NAME: 'Fixture',
              GIT_AUTHOR_EMAIL: 'fixture@example.test',
              GIT_COMMITTER_NAME: 'Fixture',
              GIT_COMMITTER_EMAIL: 'fixture@example.test',
            },
          })
        ).stdout.trim();
      };
      try {
        await mkdir(cwd);
        await git(['init', '--bare', remote]);
        await git(['init', '--initial-branch=main']);
        await writeFile(join(cwd, 'poem.md'), 'original\n');
        await git(['add', 'poem.md']);
        await git(['commit', '-m', 'base']);
        await git(['remote', 'add', 'origin', remote]);
        await git(['push', '--set-upstream', 'origin', 'main']);
        const base = await git(['rev-parse', 'HEAD']);
        await git(['switch', '-c', 'task', '--track', 'origin/main']);
        await writeFile(join(cwd, 'poem.md'), 'first poem\n');
        await git(['commit', '-am', 'poem']);
        const head = await git(['rev-parse', 'HEAD']);
        if (mode === 'already published')
          await git(['push', 'origin', `${head}:refs/heads/task`]);
        assert.equal(await git(['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/main');
        const pullRequest = { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 };
        await publishIssueDelivery({
          delivery: { creationAttempted: false, reconciled: false, pullRequest },
          publication: {
            item: {
              number: 3,
              itemDatabaseId: 3,
              itemNodeId: 'I_issue',
              repositoryOwner: 'owner',
              repositoryName: 'repo',
              repositoryDefaultBranch: 'main',
            },
            branch: 'task',
            headSha: head,
            repositoryNodeId: 'R_repo',
          },
          provider: {
            inspect: async () => pullRequest,
            publish: async () => pullRequest,
          },
          git,
          ...(mode === 'already published'
            ? { push: async () => assert.fail('an observed published head must not be pushed again') }
            : mode === 'native push'
              ? {
                  push: async (sha: string, ref: string) => {
                    await git(['push', '--set-upstream', 'origin', `${sha}:${ref}`]);
                  },
                }
              : {}),
          authorize: async () => {},
          save: async () => {},
        });
        assert.equal(await git(['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/task');
        await writeFile(join(cwd, 'poem.md'), 'follow-up poem\n');
        await git(['commit', '-am', 'follow-up']);
        await git(['push']);
        const updated = await git(['rev-parse', 'HEAD']);
        assert.equal(
          await git(['ls-remote', '--heads', 'origin', 'task']),
          `${updated}\trefs/heads/task`,
        );
        assert.equal(
          await git(['ls-remote', '--heads', 'origin', 'main']),
          `${base}\trefs/heads/main`,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
});
