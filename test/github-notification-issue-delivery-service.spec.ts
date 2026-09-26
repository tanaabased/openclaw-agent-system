import assert from 'node:assert/strict';

import type { AgentSystemCliResult } from '../api/types.ts';
import GitHubNotificationIssueDeliveryService from '../channels/github/conversation/issue-delivery-service.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { GitHubIdentityPin } from '../channels/github/config-schema.ts';
import type { GitToolConfiguration } from '../tools/git/config-schema.ts';
import { classifyGitOperation } from '../tools/git/operation-classifier.ts';
import { authorizeGitOperation } from '../tools/git/policy.ts';
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
const gitConfiguration: GitToolConfiguration = { agent: {}, git: {} };

function cliResult(stdout = ''): AgentSystemCliResult {
  return { exitCode: 0, stderr: '', stdout, timedOut: false, truncated: false };
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    baseRef: 'main',
    body: 'Closes #12',
    headRef: worktree.branch,
    headRepository: 'tanaabased/example',
    itemNodeId: 'PR_delivery',
    number: 45,
    state: 'open',
    title: 'Add the missing fixture',
    url: 'https://github.com/tanaabased/example/pull/45',
    ...overrides,
  };
}

function issue() {
  return {
    authorLogin: 'reporter',
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
    assignees?: 'assignment-actor' | GitHubIdentityPin[];
    reviewers?: GitHubIdentityPin[];
    existingAssignees?: GitHubIdentityPin[];
    existingRequestedReviewers?: string[];
    completedReviewers?: string[];
    failReviewRequestOnce?: boolean;
    ineligibleAssignee?: string;
    ineligibleReviewer?: string;
  } = {},
) {
  let amended = false;
  let createdPullRequest = options.existingPullRequest;
  let failReviewRequest = options.failReviewRequestOnce ?? false;
  const currentAssignees = [...(options.existingAssignees ?? [])];
  const requestedReviewers = new Set(options.existingRequestedReviewers ?? []);
  const configuration: AgentManifest =
    options.assignees === undefined && options.reviewers === undefined
      ? manifest
      : {
          ...manifest,
          github: {
            ...manifest.github,
            notifications: {
              assignmentTypes: ['issue', 'pull-request'],
              approvedActors: [{ login: 'pirog', nodeId: 'U_actor' }],
              intervalMinutes: 5,
              maxConcurrentIssues: 2,
              pullRequest: {
                assignees: options.assignees ?? 'assignment-actor',
                reviewers: options.reviewers ?? [],
              },
            },
          },
        };
  const gitRequests: Array<{ argv: string[]; stdin?: string; workspaceDir: string }> = [];
  const githubRequests: Array<{ argv: string[]; stdin?: string }> = [];
  const delivery = new GitHubNotificationIssueDeliveryService({
    accountClient: {
      async connect(context, trigger) {
        assert.equal(context.manifest, configuration);
        assert.equal(context.workspaceDir, workspaceDir);
        assert.equal(trigger, 'service');
        return {
          async execute(argv, stdin) {
            githubRequests.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
            const endpoint = argv.find(
              (argument) => argument.startsWith('repos/') || argument.startsWith('users/'),
            );
            if (endpoint === 'repos/tanaabased/example/issues/12') {
              return cliResult(JSON.stringify(issue()));
            }
            if (endpoint === 'repos/tanaabased/example/issues/45' && !argv.includes('POST')) {
              return cliResult(JSON.stringify(currentAssignees));
            }
            if (endpoint?.startsWith('users/')) {
              const login = endpoint.slice('users/'.length);
              const known = [
                { login: 'pirog', nodeId: 'U_actor' },
                { login: 'maintainer', nodeId: 'U_maintainer' },
                { login: 'reviewer', nodeId: 'U_reviewer' },
              ].find((identity) => identity.login === login);
              return cliResult(JSON.stringify(known ? [known] : []));
            }
            if (endpoint === 'repos/tanaabased/example/pulls' && argv.includes('GET')) {
              return cliResult(JSON.stringify(createdPullRequest ? [createdPullRequest] : []));
            }
            if (endpoint === 'repos/tanaabased/example/pulls' && argv.includes('POST')) {
              createdPullRequest = pullRequest();
              return cliResult(JSON.stringify(createdPullRequest));
            }
            if (endpoint === 'repos/tanaabased/example/pulls/45' && argv.includes('PATCH')) {
              return cliResult(JSON.stringify(pullRequest()));
            }
            if (endpoint === 'repos/tanaabased/example/issues/45/assignees') {
              if (argv.includes('POST')) {
                for (const login of (JSON.parse(stdin ?? '{}') as { assignees: string[] })
                  .assignees) {
                  const pin = [
                    { login: 'pirog', nodeId: 'U_actor' },
                    { login: 'maintainer', nodeId: 'U_maintainer' },
                  ].find((identity) => identity.login === login);
                  if (pin && !currentAssignees.some((entry) => entry.login === login))
                    currentAssignees.push(pin);
                }
                return cliResult(JSON.stringify(currentAssignees.map(({ login }) => login)));
              }
              return cliResult(JSON.stringify(currentAssignees));
            }
            if (endpoint?.startsWith('repos/tanaabased/example/assignees/')) {
              return options.ineligibleAssignee === endpoint.split('/').at(-1)
                ? { ...cliResult(), exitCode: 1 }
                : cliResult();
            }
            if (endpoint?.startsWith('repos/tanaabased/example/collaborators/')) {
              return cliResult(
                JSON.stringify({
                  permission:
                    options.ineligibleReviewer === endpoint.split('/').at(-2) ? 'none' : 'write',
                }),
              );
            }
            if (endpoint === 'repos/tanaabased/example/pulls/45/requested_reviewers') {
              if (argv.includes('POST')) {
                if (failReviewRequest) {
                  failReviewRequest = false;
                  return { ...cliResult(), exitCode: 1 };
                }
                for (const login of (JSON.parse(stdin ?? '{}') as { reviewers: string[] })
                  .reviewers)
                  requestedReviewers.add(login);
                return cliResult(JSON.stringify([...requestedReviewers]));
              }
              return cliResult(JSON.stringify([...requestedReviewers]));
            }
            if (endpoint === 'repos/tanaabased/example/pulls/45/reviews') {
              return cliResult(JSON.stringify(options.completedReviewers ?? []));
            }
            throw new Error(`unexpected GitHub request: ${argv.join(' ')}`);
          },
          identity: { login: agentId, nodeId: 'U_agent' },
        };
      },
    },
    git: {
      async execute(input) {
        assert.deepEqual(
          await authorizeGitOperation(classifyGitOperation({ argv: input.argv }), gitConfiguration),
          { status: 'allowed' },
          input.argv.join(' '),
        );
        gitRequests.push({
          argv: input.argv,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          workspaceDir: input.workspaceDir,
        });
        const command = input.argv[0];
        if (command === 'branch') return cliResult(`${worktree.branch}\n`);
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
          manifest: configuration,
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

    assert.deepEqual(receipt, {
      pullRequestNodeId: 'PR_delivery',
      pullRequestNumber: 45,
    });
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

  it('should add pinned recipients without removing existing assignees or re-requesting completed reviews', async () => {
    const scenario = serviceHarness({
      assignees: [{ login: 'maintainer', nodeId: 'U_maintainer' }],
      reviewers: [{ login: 'reviewer', nodeId: 'U_reviewer' }],
      existingAssignees: [{ login: 'pirog', nodeId: 'U_actor' }],
      completedReviewers: ['reviewer'],
      existingRequestedReviewers: ['codeowner'],
      existingPullRequest: pullRequest(),
      remoteSha: originalSha,
      commitMessage: '#12: add fixture file\n',
    });
    await scenario.delivery.deliver({
      agentId,
      item: approvedNotificationItem(),
      workspaceDir,
      worktree,
    });
    const assign = scenario.githubRequests.find(
      ({ argv }) =>
        argv.includes('POST') && argv.includes('repos/tanaabased/example/issues/45/assignees'),
    );
    assert.deepEqual(JSON.parse(assign?.stdin ?? ''), { assignees: ['maintainer'] });
    assert.equal(
      scenario.githubRequests.some(
        ({ argv }) => argv.includes('POST') && argv.includes('requested_reviewers'),
      ),
      false,
    );
  });

  it('should resume recipient reconciliation on the same pull request after a review request failure', async () => {
    const scenario = serviceHarness({
      reviewers: [{ login: 'reviewer', nodeId: 'U_reviewer' }],
      failReviewRequestOnce: true,
      commitMessage: '#12: add fixture file\n',
      remoteSha: originalSha,
    });
    const input = { agentId, item: approvedNotificationItem(), workspaceDir, worktree };
    await assert.rejects(scenario.delivery.deliver(input), /requested_reviewers/u);
    await scenario.delivery.deliver(input);
    assert.equal(
      scenario.githubRequests.filter(
        ({ argv }) =>
          argv.includes('POST') && argv.includes('repos/tanaabased/example/issues/45/assignees'),
      ).length,
      1,
    );
    assert.equal(
      scenario.githubRequests.filter(
        ({ argv }) =>
          argv.includes('POST') && argv.some((arg) => arg.endsWith('/requested_reviewers')),
      ).length,
      2,
    );
  });

  it('should honor empty assignee and reviewer lists', async () => {
    const scenario = serviceHarness({ assignees: [], reviewers: [] });
    await scenario.delivery.deliver({
      agentId,
      item: approvedNotificationItem(),
      workspaceDir,
      worktree,
    });
    assert.equal(
      scenario.githubRequests.some(
        ({ argv }) => argv.includes('POST') && argv.includes('issues/45/assignees'),
      ),
      false,
    );
    assert.equal(
      scenario.githubRequests.some(
        ({ argv }) => argv.includes('POST') && argv.includes('requested_reviewers'),
      ),
      false,
    );
  });

  it('should reject unavailable actor pins and ineligible assignees', async () => {
    const input = {
      agentId,
      item: { ...approvedNotificationItem(), assignmentActorNodeId: undefined },
      workspaceDir,
      worktree,
    };
    await assert.rejects(
      serviceHarness().delivery.deliver(input),
      /assignment actor identity is unavailable/u,
    );
    const scenario = serviceHarness({ ineligibleAssignee: 'pirog' });
    await assert.rejects(
      scenario.delivery.deliver({ ...input, item: approvedNotificationItem() }),
      /assignee eligibility for pirog/u,
    );
  });

  it('should reject a reviewer pin for the agent itself', async () => {
    const scenario = serviceHarness({ reviewers: [{ login: 'tanaabot', nodeId: 'U_agent' }] });
    await assert.rejects(
      scenario.delivery.deliver({
        agentId,
        item: approvedNotificationItem(),
        workspaceDir,
        worktree,
      }),
      /cannot request its own review/u,
    );
  });

  it('should reject mismatched reviewer pins and ineligible reviewers without requesting review', async () => {
    const input = { agentId, item: approvedNotificationItem(), workspaceDir, worktree };
    const mismatch = serviceHarness({ reviewers: [{ login: 'reviewer', nodeId: 'U_wrong' }] });
    await assert.rejects(
      mismatch.delivery.deliver(input),
      /recipient pin does not match reviewer/u,
    );
    const ineligible = serviceHarness({
      reviewers: [{ login: 'reviewer', nodeId: 'U_reviewer' }],
      ineligibleReviewer: 'reviewer',
    });
    await assert.rejects(ineligible.delivery.deliver(input), /reviewer reviewer is not eligible/u);
    assert.equal(
      ineligible.githubRequests.some(
        ({ argv }) =>
          argv.includes('POST') && argv.some((arg) => arg.endsWith('/requested_reviewers')),
      ),
      false,
    );
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
