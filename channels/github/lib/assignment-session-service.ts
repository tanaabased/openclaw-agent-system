import { isAbsolute, resolve } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { GitHubNotificationAssignmentBoundaryInput } from './assignment-orchestrator.ts';
import {
  githubNotificationConversationId,
  type GitHubNotificationAssignmentEvent,
} from '../channel.ts';
import type { GitHubNotificationExecutionMode } from '../messages/types.ts';
import type { GitHubNotificationObservedWorktree } from '../utils/delivery-plan.ts';
import type { GitHubNotificationPullRequestState } from '../utils/monitor-state.ts';
import { resolveNotificationRoute, type ResolvedNotificationRoute } from '../utils/routing.ts';

export interface GitHubNotificationAssignmentSessionServiceDependencies {
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

export interface GitHubNotificationAssignmentSessionInput extends GitHubNotificationAssignmentBoundaryInput {
  worktree?: GitHubNotificationObservedWorktree;
}

export interface ResolvedGitHubNotificationAssignmentSession {
  config: OpenClawConfig;
  event: Pick<GitHubNotificationAssignmentEvent, 'id' | 'itemNumber' | 'itemType' | 'repositoryId'>;
  label: string;
  mode: GitHubNotificationExecutionMode;
  route: ResolvedNotificationRoute;
  workContext: Record<string, string>;
}

export function githubNotificationRequiredText(
  value: string,
  label: string,
  maximumLength?: number,
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (maximumLength !== undefined && normalized.length > maximumLength) {
    throw new Error(`${label} must not exceed ${maximumLength} characters.`);
  }
  return normalized;
}

function absolutePath(value: string, label: string): string {
  const normalized = resolve(githubNotificationRequiredText(value, label, 4_096));
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return normalized;
}

function assignmentContext(input: {
  itemType: GitHubNotificationAssignmentEvent['itemType'];
  pullRequest?: GitHubNotificationPullRequestState;
  worktree?: GitHubNotificationObservedWorktree;
}): Record<string, string> {
  if (input.itemType === 'issue') {
    if (!input.worktree) throw new Error('GitHub issue assignments require a managed worktree.');
    return {
      githubWorktreeBranch: githubNotificationRequiredText(
        input.worktree.branch,
        'GitHub notification worktree branches',
        255,
      ),
      githubWorktreePath: absolutePath(input.worktree.path, 'GitHub notification worktree paths'),
    };
  }
  if (!input.pullRequest) {
    throw new Error('GitHub pull-request assignments require observed head metadata.');
  }
  const headSha = githubNotificationRequiredText(
    input.pullRequest.headSha,
    'GitHub pull-request head SHAs',
    64,
  );
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(headSha)) {
    throw new Error('GitHub pull-request head SHAs are invalid.');
  }
  return {
    githubPullRequestHeadRef: githubNotificationRequiredText(
      input.pullRequest.headRef,
      'GitHub pull-request head refs',
      255,
    ),
    githubPullRequestHeadSha: headSha,
  };
}

/** Resolve one authorized assignment to its stable OpenClaw session route and work context. */
export default class GitHubNotificationAssignmentSessionService {
  readonly #dependencies: GitHubNotificationAssignmentSessionServiceDependencies;

  public constructor(dependencies: GitHubNotificationAssignmentSessionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async resolve(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<ResolvedGitHubNotificationAssignmentSession> {
    const config = await this.#dependencies.readConfig();
    const desired = {
      agentId: input.agentId,
      enabled: true,
      workspaceDir: input.workspaceDir,
    };
    const mode = input.delivery.mode ?? 'plan';
    const event = {
      id: input.delivery.assignmentEventId,
      itemNumber: input.item.number,
      itemType: input.item.itemType,
      repositoryId: input.item.repositoryNodeId,
    };
    const route = resolveNotificationRoute(
      config,
      desired,
      githubNotificationConversationId(event),
    );
    const assignmentLabel =
      input.item.itemType === 'issue'
        ? input.worktree?.branch
        : input.item.pullRequest === undefined
          ? undefined
          : `head@${input.item.pullRequest.headSha.slice(0, 12)}`;
    if (!assignmentLabel) {
      throw new Error(
        `GitHub ${input.item.itemType} assignments are missing their required local context.`,
      );
    }
    const label =
      `${input.item.repositoryOwner}/${input.item.repositoryName}#${input.item.number} · ${assignmentLabel}`
        .slice(0, 120)
        .trim();
    const workContext = assignmentContext({
      itemType: event.itemType,
      ...(input.item.pullRequest === undefined ? {} : { pullRequest: input.item.pullRequest }),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    });
    return { config, event, label, mode, route, workContext };
  }
}
