import { githubNotificationConversationId } from '../channel.ts';
import githubNotificationAssignmentAcknowledgment from '../events/assignment-acknowledgment.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';
import { githubWorkItemKey } from '../provider/work-item.ts';
import type GitHubNotificationCommentPublicationService from '../publication/comment-publication-service.ts';
import { githubNotificationPublicationTarget } from '../publication/publication.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
} from './conversation-state.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';

export interface GitHubNotificationAssignmentAcknowledgmentServiceDependencies {
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  publications: Pick<GitHubNotificationCommentPublicationService, 'publish'>;
}

export interface GitHubNotificationAssignmentAcknowledgmentInput {
  agentId: string;
  item: GitHubNotificationItemState;
  modeId: GitHubNotificationModeId;
  signal?: AbortSignal;
  workspaceDir: string;
}

/** Checkpoint and publish one deterministic assignment acknowledgment. */
export default class GitHubNotificationAssignmentAcknowledgmentService {
  readonly #dependencies: GitHubNotificationAssignmentAcknowledgmentServiceDependencies;

  constructor(dependencies: GitHubNotificationAssignmentAcknowledgmentServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async publish(input: GitHubNotificationAssignmentAcknowledgmentInput): Promise<void> {
    const intake = input.item.intake;
    if (!intake || intake.assignmentEventId !== input.item.assignmentEventNodeId) {
      throw new Error('The GitHub assignment acknowledgment is missing its intake identity.');
    }
    const conversationId = githubNotificationConversationId({
      itemNumber: input.item.number,
      lifecycleId: input.item.lifecycleId,
      repositoryId: input.item.repositoryNodeId,
    });
    const itemKey = githubWorkItemKey(input.item.repositoryNodeId, input.item.number);
    const target = githubNotificationPublicationTarget({
      intent: 'initial-acknowledgment',
      item: input.item,
      publicationId: intake.assignmentEventId,
    });
    let state =
      (await this.#dependencies.conversationStateStore.read(input.agentId)) ??
      createGitHubNotificationConversationState(input.agentId, input.workspaceDir);
    if (state.workspaceDir !== input.workspaceDir) {
      throw new Error('The GitHub assignment acknowledgment belongs to another workspace.');
    }
    const conversation = state.conversations[conversationId];
    if (
      conversation &&
      (conversation.itemKey !== itemKey ||
        conversation.lifecycleId !== input.item.lifecycleId ||
        conversation.mode !== input.modeId)
    ) {
      throw new Error('The GitHub assignment acknowledgment conversation identity is invalid.');
    }
    if (conversation?.acknowledgment?.status === 'published') return;

    let acknowledgment = conversation?.acknowledgment;
    if (acknowledgment) {
      if (acknowledgment.target !== target) {
        throw new Error('The GitHub assignment acknowledgment target has changed.');
      }
    } else {
      const publicText = githubNotificationAssignmentAcknowledgment(
        input.agentId,
        intake.assignmentEventId,
        input.modeId,
      );
      acknowledgment = {
        publicText,
        publicTextDigest: githubNotificationPublicTextDigest(publicText),
        status: 'pending',
        target,
      };
      state = structuredClone(state);
      state.conversations[conversationId] = {
        ...(conversation ?? {
          baselineEstablished: false,
          itemKey,
          lifecycleId: input.item.lifecycleId,
          mode: input.modeId,
          revisions: {},
        }),
        acknowledgment,
      };
      await this.#dependencies.conversationStateStore.write(state);
    }

    const result = await this.#dependencies.publications.publish({
      accountId: input.agentId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      target: acknowledgment.target,
      text: acknowledgment.publicText,
    });
    const current = await this.#dependencies.conversationStateStore.read(input.agentId);
    const currentConversation = current?.conversations[conversationId];
    if (!current || currentConversation?.acknowledgment?.target !== target) {
      throw new Error('The GitHub assignment acknowledgment checkpoint is missing.');
    }
    if (currentConversation.acknowledgment.status === 'published') return;
    const next = structuredClone(current);
    next.conversations[conversationId]!.acknowledgment = {
      ...currentConversation.acknowledgment,
      commentDatabaseId: result.receipt.databaseId,
      commentNodeId: result.receipt.nodeId,
      status: 'published',
    };
    await this.#dependencies.conversationStateStore.write(next);
  }
}
