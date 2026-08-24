import { resolve } from 'node:path';

import type { AgentSystemCliResult } from '../../../api/types.ts';
import type GitHubAccountClient from '../../../core/github-account-client.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import type { GitHubNotificationLifecycleWorktree } from '../lifecycles/types.ts';

export interface GitHubNotificationIssueDeliveryReceipt {
  pullRequestNumber: number;
}

export interface GitHubNotificationGitExecutor {
  execute(input: {
    agentId: string;
    argv: string[];
    signal?: AbortSignal;
    stdin?: string;
    workspaceDir: string;
  }): Promise<AgentSystemCliResult>;
}

export interface GitHubNotificationIssueDeliveryServiceDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  git: GitHubNotificationGitExecutor;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
}

export interface GitHubNotificationIssueDeliveryInput {
  agentId: string;
  item: GitHubNotificationItemState;
  signal?: AbortSignal;
  workspaceDir: string;
  worktree: GitHubNotificationLifecycleWorktree;
}

interface IssueIdentity {
  authorLogin: string;
  title: string;
}

interface PullRequestIdentity {
  baseRef: string;
  body: string;
  headRef: string;
  headRepository: string;
  number: number;
  state: string;
  title: string;
}

const commitShaPattern = /^[a-f0-9]{40,64}$/u;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximumLength ||
    value.includes('\0')
  ) {
    throw new Error(`GitHub returned an invalid ${label}.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length > maximumLength || value.includes('\0')) {
    throw new Error(`GitHub returned an invalid ${label}.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`GitHub returned an invalid ${label}.`);
  }
  return Number(value);
}

function parseIssue(value: unknown, item: GitHubNotificationItemState): IssueIdentity {
  const issue = record(value, 'issue delivery context');
  if (
    positiveInteger(issue.databaseId, 'issue database id') !== item.itemDatabaseId ||
    requiredString(issue.nodeId, 'issue node id', 255) !== item.itemNodeId ||
    positiveInteger(issue.number, 'issue number') !== item.number
  ) {
    throw new Error('GitHub returned a different issue during delivery.');
  }
  const authorLogin = requiredString(issue.authorLogin, 'issue author', 100);
  if (!loginPattern.test(authorLogin)) throw new Error('GitHub returned an invalid issue author.');
  return {
    authorLogin,
    title: requiredString(issue.title, 'issue title', 512).trim(),
  };
}

function parsePullRequest(value: unknown): PullRequestIdentity {
  const pullRequest = record(value, 'pull request delivery context');
  return {
    baseRef: requiredString(pullRequest.baseRef, 'pull request base ref', 255),
    body:
      pullRequest.body === null || pullRequest.body === undefined
        ? ''
        : boundedString(pullRequest.body, 'pull request body', 65_536),
    headRef: requiredString(pullRequest.headRef, 'pull request head ref', 255),
    headRepository: requiredString(pullRequest.headRepository, 'pull request head repository', 255),
    number: positiveInteger(pullRequest.number, 'pull request number'),
    state: requiredString(pullRequest.state, 'pull request state', 32),
    title: requiredString(pullRequest.title, 'pull request title', 512),
  };
}

function normalizedCommitMessage(message: string, issueNumber: number): string {
  const normalized = message.replace(/\r\n?/gu, '\n').trimEnd();
  if (!normalized || normalized.includes('\0')) {
    throw new Error('The implementation commit message is empty or invalid.');
  }
  const prefix = `#${issueNumber}: `;
  return normalized.startsWith(prefix) ? `${normalized}\n` : `${prefix}${normalized}\n`;
}

function pullRequestProjection() {
  return '{baseRef:.base.ref,body,headRef:.head.ref,headRepository:(.head.repo.full_name//""),number,state,title}';
}

/** Normalize one local issue commit, perform its first push, and reconcile its pull request. */
export default class GitHubNotificationIssueDeliveryService {
  readonly #dependencies: GitHubNotificationIssueDeliveryServiceDependencies;

  constructor(dependencies: GitHubNotificationIssueDeliveryServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async deliver(
    input: GitHubNotificationIssueDeliveryInput,
  ): Promise<GitHubNotificationIssueDeliveryReceipt> {
    if (input.item.lifecycleId !== 'issue' || input.item.itemType !== 'issue') {
      throw new Error('Issue delivery requires an issue lifecycle item.');
    }
    const branch = (await this.#git(input, ['branch', '--show-current'])).trim();
    if (branch !== input.worktree.branch) {
      throw new Error('The implementation worktree is not on its lifecycle-managed branch.');
    }
    const status = await this.#git(input, ['status', '--porcelain=v1']);
    if (status) throw new Error('The implementation worktree still contains uncommitted changes.');

    const commitCount = (
      await this.#git(input, [
        'rev-list',
        '--count',
        `refs/remotes/origin/${input.item.repositoryDefaultBranch}..HEAD`,
      ])
    ).trim();
    if (commitCount !== '1') {
      throw new Error('Issue delivery requires exactly one local implementation commit.');
    }

    const originalSha = (await this.#git(input, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (!commitShaPattern.test(originalSha)) {
      throw new Error('Git returned an invalid implementation commit id.');
    }
    const originalMessage = await this.#git(input, ['log', '-1', '--format=%B']);
    const commitMessage = normalizedCommitMessage(originalMessage, input.item.number);
    if (commitMessage !== `${originalMessage.replace(/\r\n?/gu, '\n').trimEnd()}\n`) {
      await this.#git(input, ['commit', '--amend', '--file=-'], commitMessage);
    }
    const commitSha = (await this.#git(input, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (!commitShaPattern.test(commitSha)) {
      throw new Error('Git returned an invalid normalized commit id.');
    }
    if (await this.#git(input, ['status', '--porcelain=v1'])) {
      throw new Error('Commit normalization left the implementation worktree dirty.');
    }

    const remoteRef = `refs/heads/${branch}`;
    const remote = await this.#git(input, ['ls-remote', '--heads', 'origin', remoteRef]);
    const remoteSha = remote.trim() ? remote.trim().split(/\s+/u)[0] : undefined;
    if (remoteSha !== undefined && remoteSha !== commitSha) {
      throw new Error('The managed remote branch already points at a different commit.');
    }
    if (remoteSha === undefined) {
      await this.#git(input, ['push', '--set-upstream', 'origin', `HEAD:${remoteRef}`]);
    }

    const loaded = await this.#dependencies.manifestService.loadForAgentId(
      input.agentId,
      'service',
    );
    if (
      loaded.status !== 'loaded' ||
      loaded.manifest.agent.id !== input.agentId ||
      resolve(loaded.scope.workspaceDir) !== resolve(input.workspaceDir)
    ) {
      throw new Error('The GitHub delivery manifest binding is unavailable.');
    }
    const github = await this.#dependencies.accountClient.connect(
      { manifest: loaded.manifest, workspaceDir: loaded.scope.workspaceDir },
      'service',
      input.signal,
    );
    const repository = `${input.item.repositoryOwner}/${input.item.repositoryName}`;
    const issue = parseIssue(
      await this.#github(
        github,
        [
          'api',
          `repos/${repository}/issues/${input.item.number}`,
          '--jq',
          '{authorLogin:.user.login,databaseId:.id,nodeId:.node_id,number,title}',
        ],
        input.signal,
      ),
      input.item,
    );
    const pullRequests = await this.#github(
      github,
      [
        'api',
        '--method',
        'GET',
        `repos/${repository}/pulls`,
        '-f',
        'state=all',
        '-f',
        `head=${input.item.repositoryOwner}:${branch}`,
        '--jq',
        `[.[]|${pullRequestProjection()}]`,
      ],
      input.signal,
    );
    if (!Array.isArray(pullRequests) || pullRequests.length > 1) {
      throw new Error('GitHub returned an ambiguous pull request for the managed branch.');
    }
    let pullRequest =
      pullRequests.length === 0
        ? parsePullRequest(
            await this.#github(
              github,
              [
                'api',
                '--method',
                'POST',
                `repos/${repository}/pulls`,
                '--input',
                '-',
                '--jq',
                pullRequestProjection(),
              ],
              input.signal,
              JSON.stringify({
                base: input.item.repositoryDefaultBranch,
                body: `Closes #${input.item.number}`,
                head: branch,
                title: issue.title,
              }),
            ),
          )
        : parsePullRequest(pullRequests[0]);
    if (
      pullRequest.headRef !== branch ||
      pullRequest.headRepository.toLowerCase() !== repository.toLowerCase() ||
      pullRequest.state !== 'open'
    ) {
      throw new Error('The managed branch belongs to an incompatible pull request.');
    }

    const body = `Closes #${input.item.number}`;
    if (
      pullRequest.baseRef !== input.item.repositoryDefaultBranch ||
      pullRequest.body !== body ||
      pullRequest.title !== issue.title
    ) {
      pullRequest = parsePullRequest(
        await this.#github(
          github,
          [
            'api',
            '--method',
            'PATCH',
            `repos/${repository}/pulls/${pullRequest.number}`,
            '--input',
            '-',
            '--jq',
            pullRequestProjection(),
          ],
          input.signal,
          JSON.stringify({
            base: input.item.repositoryDefaultBranch,
            body,
            title: issue.title,
          }),
        ),
      );
    }
    const assignees = await this.#github(
      github,
      [
        'api',
        '--method',
        'POST',
        `repos/${repository}/issues/${pullRequest.number}/assignees`,
        '--input',
        '-',
        '--jq',
        '[.assignees[].login]',
      ],
      input.signal,
      JSON.stringify({ assignees: [issue.authorLogin] }),
    );
    if (
      !Array.isArray(assignees) ||
      !assignees.some(
        (login) =>
          typeof login === 'string' && login.toLowerCase() === issue.authorLogin.toLowerCase(),
      )
    ) {
      throw new Error('GitHub did not assign the issue author to the pull request.');
    }
    if (
      pullRequest.baseRef !== input.item.repositoryDefaultBranch ||
      pullRequest.body !== body ||
      pullRequest.title !== issue.title
    ) {
      throw new Error('GitHub did not retain the normalized pull request shape.');
    }
    return {
      pullRequestNumber: pullRequest.number,
    };
  }

  async #git(
    input: GitHubNotificationIssueDeliveryInput,
    argv: string[],
    stdin?: string,
  ): Promise<string> {
    const result = await this.#dependencies.git.execute({
      agentId: input.agentId,
      argv,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(stdin === undefined ? {} : { stdin }),
      workspaceDir: resolve(input.worktree.path),
    });
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      throw new Error(`Git delivery command failed: ${argv[0] ?? 'unknown'}.`);
    }
    return result.stdout;
  }

  async #github(
    client: Awaited<ReturnType<GitHubAccountClient['connect']>>,
    argv: string[],
    signal?: AbortSignal,
    stdin?: string,
  ): Promise<unknown> {
    const result = await client.execute(argv, stdin, {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: 60_000,
    });
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      throw new Error('GitHub rejected issue delivery reconciliation.');
    }
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error('GitHub returned invalid issue delivery data.', { cause: error });
    }
  }
}
