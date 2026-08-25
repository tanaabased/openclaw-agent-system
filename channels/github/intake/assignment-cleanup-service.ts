import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { githubNotificationConversationId } from '../channel.ts';
import type GitHubNotificationConversationStateStore from '../conversation/conversation-state-store.ts';
import type GitHubNotificationSessionArchiveService from '../conversation/session-archive-service.ts';
import type {
  GitHubNotificationCleanupState,
  GitHubNotificationItemState,
} from './monitor/state.ts';
import type { GitHubNotificationLifecycle } from '../lifecycles/types.ts';
import { resolveNotificationRoute } from '../routing/routing.ts';
import { githubWorkItemKey } from '../provider/work-item.ts';

export interface GitHubNotificationAssignmentCleanupInput {
  agentId: string;
  item: GitHubNotificationItemState;
  lifecycle: GitHubNotificationLifecycle;
  signal?: AbortSignal;
  workspaceDir: string;
}

export interface GitHubNotificationAssignmentCleanupServiceDependencies {
  conversations: Pick<GitHubNotificationConversationStateStore, 'read'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  sessions: Pick<GitHubNotificationSessionArchiveService, 'archive'>;
}

function skipped(
  reasonCode: string,
  session: GitHubNotificationCleanupState['session'] = 'missing',
): GitHubNotificationCleanupState {
  return { reasonCode, session, status: 'skipped', worktree: 'not-applicable' };
}

function failed(reasonCode: string): GitHubNotificationCleanupState {
  return { reasonCode, session: 'failed', status: 'failed', worktree: 'not-applicable' };
}

/** Retire provider-authorized assignment resources only after durable work completion. */
export default class GitHubNotificationAssignmentCleanupService {
  readonly #dependencies: GitHubNotificationAssignmentCleanupServiceDependencies;

  constructor(dependencies: GitHubNotificationAssignmentCleanupServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async cleanup(
    input: GitHubNotificationAssignmentCleanupInput,
  ): Promise<GitHubNotificationCleanupState> {
    const intake = input.item.intake;
    if (!intake || intake.providerRetirementVerifiedAt === undefined) {
      return skipped('github-notification-cleanup-provider-verification-missing');
    }
    const conversationId = githubNotificationConversationId({
      itemNumber: input.item.number,
      lifecycleId: input.item.lifecycleId,
      repositoryId: input.item.repositoryNodeId,
    });
    let state: Awaited<ReturnType<GitHubNotificationConversationStateStore['read']>>;
    try {
      state = await this.#dependencies.conversations.read(input.agentId);
    } catch {
      return failed('github-notification-cleanup-conversation-read-failed');
    }
    const conversation = state?.conversations[conversationId];
    if (
      !state ||
      state.workspaceDir !== input.workspaceDir ||
      !conversation ||
      conversation.lifecycleId !== input.item.lifecycleId ||
      conversation.itemKey !== githubWorkItemKey(input.item.repositoryNodeId, input.item.number)
    ) {
      return skipped('github-notification-cleanup-conversation-missing');
    }
    if (conversation.activeTurn) {
      return skipped('github-notification-cleanup-turn-active');
    }
    if (conversation.implementation?.status !== 'completed') {
      return skipped('github-notification-cleanup-implementation-incomplete');
    }

    let sessionKey: string;
    try {
      sessionKey = resolveNotificationRoute(
        await this.#dependencies.readConfig(),
        { agentId: input.agentId, enabled: true, workspaceDir: input.workspaceDir },
        conversationId,
      ).sessionKey;
    } catch {
      return failed('github-notification-cleanup-routing-failed');
    }
    let session: GitHubNotificationCleanupState['session'];
    try {
      session = await this.#dependencies.sessions.archive(input.agentId, sessionKey);
    } catch {
      return failed('github-notification-cleanup-session-failed');
    }
    if (session === 'pinned') {
      return skipped('github-notification-cleanup-session-pinned', 'pinned');
    }

    const owner = input.lifecycle.worktree;
    if (!owner.required) {
      return {
        reasonCode: 'github-notification-cleanup-completed',
        session,
        status: 'completed',
        worktree: 'not-applicable',
      };
    }
    if (!intake.worktreeBranch || !intake.worktreePath) {
      return {
        reasonCode: 'github-notification-cleanup-worktree-missing',
        session,
        status: 'completed',
        worktree: 'missing',
      };
    }
    let worktree: Awaited<ReturnType<typeof owner.cleanup>>['status'];
    try {
      worktree = (
        await owner.cleanup({
          agentId: input.agentId,
          intake,
          item: input.item,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          workspaceDir: input.workspaceDir,
          worktree: { branch: intake.worktreeBranch, path: intake.worktreePath },
        })
      ).status;
    } catch {
      worktree = 'failed';
    }
    const status =
      worktree === 'removed' || worktree === 'missing'
        ? 'completed'
        : worktree === 'failed'
          ? 'failed'
          : 'skipped';
    return {
      reasonCode: `github-notification-cleanup-worktree-${worktree}`,
      session,
      status,
      worktree,
    };
  }
}
