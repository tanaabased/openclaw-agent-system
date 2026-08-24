import assert from 'node:assert/strict';

import type { AgentSystemCliResult } from '../api/types.ts';
import GitHubNotificationIssueDeliveryService from '../channels/github/conversation/issue-delivery-service.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace';
const worktree = { branch: 'github-3-issue-7', path: '/worktrees/github-3-issue-7' };
const originalSha = 'a'.repeat(40);
const normalizedSha = 'b'.repeat(40);
const manifest: AgentManifest = {
  agent: { id: agentId },
  github: { token: 'GITHUB_TOKEN', username: 'tanaabot' },
  schemaVersion: 1,
};

function cliResult(stdout = ''): AgentSystemCliResult {
  return { exitCode: 0, stderr: '', stdout, timedOut: false, truncated: false };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    baseRef: 'main',
    body: 'Closes #12',
    headRef: worktree.branch,
    headRepository: 'tanaabased/example',
    nodeId: 'PR_delivery',
    number: 45,
    state: 'open',
    title: 'Add the missing fixture',
    url: 'https://github.com/tanaabased/example/pull/45',
    ...overrides,
  };
}

function issue() {
  return {
    authorLogin: 'pirog',
    databaseId: 7,
    nodeId: 'I_item',
    number: 12,
    title: 'Add the missing fixture',
  };
}

function serviceHarness(
  options: {
    commitMessage?: string;
    existingPullRequest?: Record<string, unknown>;
    remoteSha?: string;
  } = {},
) {
  let amended = false;
  const gitRequests: Array<{ argv: string[]; stdin?: string; workspaceDir: string }> = [];
  const githubRequests: Array<{ argv: string[]; stdin?: string }> = [];
  const delivery = new GitHubNotificationIssueDeliveryService({
    accountClient: {
      async connect(context, trigger) {
        assert.equal(context.manifest, manifest);
        assert.equal(context.workspaceDir, workspaceDir);
        assert.equal(trigger, 'service');
        return {
          async execute(argv, stdin) {
            githubRequests.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
            const endpoint = argv.find((argument) => argument.startsWith('repos/'));
            if (endpoint === 'repos/tanaabased/example/issues/12') {
              return cliResult(JSON.stringify(issue()));
            }
            if (endpoint === 'repos/tanaabased/example/pulls' && argv.includes('GET')) {
              return cliResult(
                JSON.stringify(options.existingPullRequest ? [options.existingPullRequest] : []),
              );
            }
            if (endpoint === 'repos/tanaabased/example/pulls' && argv.includes('POST')) {
              return cliResult(JSON.stringify(pullRequest()));
            }
            if (endpoint === 'repos/tanaabased/example/pulls/45' && argv.includes('PATCH')) {
              return cliResult(JSON.stringify(pullRequest()));
            }
            if (endpoint === 'repos/tanaabased/example/issues/45/assignees') {
              return cliResult(JSON.stringify(['pirog']));
            }
            throw new Error(`unexpected GitHub request: ${argv.join(' ')}`);
          },
          identity: { login: agentId, nodeId: 'U_agent' },
        };
      },
    },
    git: {
      async execute(input) {
        gitRequests.push({
          argv: input.argv,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          workspaceDir: input.workspaceDir,
        });
        const command = input.argv[0];
        if (command === 'symbolic-ref') return cliResult(`${worktree.branch}\n`);
        if (command === 'status') return cliResult();
        if (command === 'rev-list') return cliResult('1\n');
        if (command === 'rev-parse') return cliResult(`${amended ? normalizedSha : originalSha}\n`);
        if (command === 'log') return cliResult(options.commitMessage ?? 'add fixture file\n');
        if (command === 'commit') {
          amended = true;
          return cliResult();
        }
        if (command === 'ls-remote') {
          return cliResult(
            options.remoteSha ? `${options.remoteSha}\trefs/heads/${worktree.branch}\n` : '',
          );
        }
        if (command === 'push') return cliResult();
        throw new Error(`unexpected Git request: ${input.argv.join(' ')}`);
      },
    },
    manifestService: {
      async loadForAgentId() {
        return {
          diagnostics: [],
          digest: 'manifest-digest',
          manifest,
          path: '/workspace/agent.yaml',
          scope: { agentId, workspaceDir },
          status: 'loaded' as const,
          validationChecks: [],
        };
      },
    },
  });
  return { delivery, gitRequests, githubRequests };
}

describe('channels/github/conversation/issue-delivery-service', () => {
  it('should prepend the trusted issue number before the first push and create the pull request', async () => {
    const scenario = serviceHarness({ commitMessage: 'add fixture file\n\nvalidated locally\n' });

    const receipt = await scenario.delivery.deliver({
      agentId,
      item: approvedNotificationItem(),
      workspaceDir,
      worktree,
    });

    assert.deepEqual(receipt, { pullRequestNumber: 45 });
    assert.equal(
      scenario.gitRequests.find(({ argv }) => argv[0] === 'commit')?.stdin,
      '#12: add fixture file\n\nvalidated locally\n',
    );
    const amendIndex = scenario.gitRequests.findIndex(({ argv }) => argv[0] === 'commit');
    const pushIndex = scenario.gitRequests.findIndex(({ argv }) => argv[0] === 'push');
    assert.ok(amendIndex >= 0 && pushIndex > amendIndex);
    const create = scenario.githubRequests.find(
      ({ argv }) => argv.includes('POST') && argv.includes('repos/tanaabased/example/pulls'),
    );
    assert.deepEqual(JSON.parse(create?.stdin ?? ''), {
      base: 'main',
      body: 'Closes #12',
      head: worktree.branch,
      title: 'Add the missing fixture',
    });
    const assign = scenario.githubRequests.find(({ argv }) =>
      argv.includes('repos/tanaabased/example/issues/45/assignees'),
    );
    assert.deepEqual(JSON.parse(assign?.stdin ?? ''), { assignees: ['pirog'] });
  });

  it('should retain an existing normalized commit and repair the pull request shape', async () => {
    const scenario = serviceHarness({
      commitMessage: '#12: add fixture file\n',
      existingPullRequest: pullRequest({
        baseRef: 'develop',
        body: 'draft details',
        title: 'draft title',
      }),
      remoteSha: originalSha,
    });

    const receipt = await scenario.delivery.deliver({
      agentId,
      item: approvedNotificationItem(),
      workspaceDir,
      worktree,
    });

    assert.equal(receipt.pullRequestNumber, 45);
    assert.equal(
      scenario.gitRequests.some(({ argv }) => argv[0] === 'commit'),
      false,
    );
    assert.equal(
      scenario.gitRequests.some(({ argv }) => argv[0] === 'push'),
      false,
    );
    const patch = scenario.githubRequests.find(({ argv }) => argv.includes('PATCH'));
    assert.deepEqual(JSON.parse(patch?.stdin ?? ''), {
      base: 'main',
      body: 'Closes #12',
      title: 'Add the missing fixture',
    });
  });

  it('should reject a conflicting remote branch without rewriting it', async () => {
    const scenario = serviceHarness({
      commitMessage: '#12: add fixture file\n',
      remoteSha: 'd'.repeat(40),
    });

    await assert.rejects(
      scenario.delivery.deliver({
        agentId,
        item: approvedNotificationItem(),
        workspaceDir,
        worktree,
      }),
      /remote branch already points at a different commit/u,
    );
    assert.equal(scenario.githubRequests.length, 0);
    assert.equal(
      scenario.gitRequests.some(({ argv }) => argv[0] === 'push'),
      false,
    );
  });
});
