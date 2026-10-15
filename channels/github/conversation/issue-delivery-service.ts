import IssueDeliveryProvider, {
  type GitHubNotificationIssueDeliveryReceipt,
} from '../publication/issue-delivery.ts';
import { legacyPullRequestRecipients } from '../pull-request-recipients.ts';
import { resolve } from 'node:path';

import { legacyGitHubNotifications } from '../config-schema.ts';
import type { AgentSystemCliResult } from '../../../api/types.ts';
import type GitHubAccountClient from '../../../core/github-account-client.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import type { GitHubNotificationLifecycleWorktree } from '../lifecycles/types.ts';

export { GitHubIssueDeliveryError } from '../publication/issue-delivery.ts';
export type {
  GitHubIssueDeliveryFailureCategory,
  GitHubNotificationIssueDeliveryReceipt,
} from '../publication/issue-delivery.ts';
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

export interface GitHubNotificationTaskPullRequestInput extends GitHubNotificationIssueDeliveryInput {
  body?: string;
  expectedPullRequest?: GitHubNotificationIssueDeliveryReceipt;
  title?: string;
}

const commitShaPattern = /^[a-f0-9]{40,64}$/u;

function normalizedCommitMessage(message: string, issueNumber: number): string {
  const normalized = message.replace(/\r\n?/gu, '\n').trimEnd();
  if (!normalized || normalized.includes('\0')) {
    throw new Error('The implementation commit message is empty or invalid.');
  }
  const prefix = `#${issueNumber}: `;
  return normalized.startsWith(prefix) ? `${normalized}\n` : `${prefix}${normalized}\n`;
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

    return this.#publishPullRequest(input, true);
  }

  /** Publish a follow-up PR on the same managed branch without rewriting authored metadata. */
  async publishTaskPullRequest(
    input: GitHubNotificationTaskPullRequestInput,
  ): Promise<GitHubNotificationIssueDeliveryReceipt> {
    if (input.item.lifecycleId !== 'issue' || input.item.itemType !== 'issue') {
      throw new Error('Task pull request publication requires an issue lifecycle item.');
    }
    const branch = (await this.#git(input, ['branch', '--show-current'])).trim();
    if (branch !== input.worktree.branch) {
      throw new Error('The task worktree is not on its lifecycle-managed branch.');
    }
    if (await this.#git(input, ['status', '--porcelain=v1'])) {
      throw new Error('The task worktree still contains uncommitted changes.');
    }
    const commitCount = Number(
      (
        await this.#git(input, [
          'rev-list',
          '--count',
          `refs/remotes/origin/${input.item.repositoryDefaultBranch}..HEAD`,
        ])
      ).trim(),
    );
    if (!Number.isSafeInteger(commitCount) || commitCount < 1) {
      throw new Error('Task pull request publication requires committed work.');
    }
    const commitSha = (await this.#git(input, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (!commitShaPattern.test(commitSha))
      throw new Error('Git returned an invalid task commit id.');
    const remoteRef = `refs/heads/${branch}`;
    const remote = await this.#git(input, ['ls-remote', '--heads', 'origin', remoteRef]);
    const remoteSha = remote.trim() ? remote.trim().split(/\s+/u)[0] : undefined;
    if (remoteSha !== undefined && remoteSha !== commitSha) {
      throw new Error('The managed remote branch does not match the task worktree.');
    }
    if (remoteSha === undefined) {
      await this.#git(input, ['push', '--set-upstream', 'origin', `HEAD:${remoteRef}`]);
    }
    return this.#publishPullRequest(input, false);
  }

  async #publishPullRequest(
    input: GitHubNotificationTaskPullRequestInput,
    normalize: boolean,
  ): Promise<GitHubNotificationIssueDeliveryReceipt> {
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
    return new IssueDeliveryProvider(github).publish(
      {
        ...input,
        branch: input.worktree.branch,
        recipients: legacyPullRequestRecipients(
          legacyGitHubNotifications(loaded.manifest.github?.notifications)?.pullRequest,
        ),
      },
      normalize,
    );
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
}
