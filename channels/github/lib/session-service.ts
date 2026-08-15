import type {
  AssembledInboundReply,
  PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { Logger } from '../../../lib/logger.ts';
import GitHubNotificationAssignmentSessionService from './assignment-session-service.ts';
import GitHubNotificationCommentTurnService, {
  type GitHubNotificationCommentTurnInput,
  type GitHubNotificationCommentTurnResult,
} from './comment-turn-service.ts';
import GitHubNotificationPlanningTurnService, {
  type GitHubNotificationPlanningTurnInput,
  type GitHubNotificationPlanningTurnResult,
} from './planning-turn-service.ts';
import type { GitHubNotificationPublications } from './publication-service.ts';

export type {
  GitHubNotificationCommentTurnInput,
  GitHubNotificationCommentTurnResult,
  GitHubNotificationPlanningTurnInput,
  GitHubNotificationPlanningTurnResult,
};

export interface GitHubNotificationSessionServiceDependencies {
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  logger: Logger;
  publicationService: GitHubNotificationPublications;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

/** Compose the normal assignment and comment turns that share one routed issue session. */
export default class GitHubNotificationSessionService {
  readonly #assignmentSessions: GitHubNotificationAssignmentSessionService;
  readonly #commentTurns: GitHubNotificationCommentTurnService;
  readonly #planningTurns: GitHubNotificationPlanningTurnService;

  public constructor(dependencies: GitHubNotificationSessionServiceDependencies) {
    this.#assignmentSessions = new GitHubNotificationAssignmentSessionService({
      readConfig: dependencies.readConfig,
    });
    this.#planningTurns = new GitHubNotificationPlanningTurnService({
      assignmentSessions: this.#assignmentSessions,
      dispatchReplyWithBufferedBlockDispatcher:
        dependencies.dispatchReplyWithBufferedBlockDispatcher,
      logger: dependencies.logger,
      publicationService: dependencies.publicationService,
      recordInboundSession: dependencies.recordInboundSession,
    });
    this.#commentTurns = new GitHubNotificationCommentTurnService({
      assignmentSessions: this.#assignmentSessions,
      dispatchReplyWithBufferedBlockDispatcher:
        dependencies.dispatchReplyWithBufferedBlockDispatcher,
      logger: dependencies.logger,
      publicationService: dependencies.publicationService,
      recordInboundSession: dependencies.recordInboundSession,
    });
  }

  public planAssignment(
    input: GitHubNotificationPlanningTurnInput,
  ): Promise<GitHubNotificationPlanningTurnResult> {
    return this.#planningTurns.planAssignment(input);
  }

  public respondToComment(
    input: GitHubNotificationCommentTurnInput,
  ): Promise<GitHubNotificationCommentTurnResult> {
    return this.#commentTurns.respondToComment(input);
  }
}
