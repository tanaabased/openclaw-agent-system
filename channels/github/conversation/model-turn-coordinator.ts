import type { AssembledInboundReply } from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import {
  GitHubNotificationReplyCandidateStoreError,
  type default as GitHubNotificationReplyCandidateStore,
} from '../publication/reply-candidate-store.ts';
import {
  GitHubNotificationPublicationError,
  githubNotificationPublicationText,
} from '../publication/publication.ts';
import type { ResolvedNotificationRoute } from '../routing/routing.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type GitHubNotificationModelTurnDispatcher from './model-turn-dispatcher.ts';
import type { GitHubNotificationHostDispatchResult } from './model-turn-dispatcher.ts';
import { githubNotificationPrivateResponse } from './private-response.ts';
import type { GitHubNotificationTurnContract } from './turn-contract.ts';

export type GitHubNotificationModelTurnPublication =
  { status: 'candidate'; publicText: string } | { status: 'withheld'; code: string };

export type GitHubNotificationModelTurnCoordinatorErrorCode =
  | 'github-notification-model-turn-prompt-selection-missing'
  | 'github-notification-model-turn-reply-candidate-failed';

export class GitHubNotificationModelTurnCoordinatorError extends Error {
  override name = 'GitHubNotificationModelTurnCoordinatorError';

  constructor(
    readonly code: GitHubNotificationModelTurnCoordinatorErrorCode,
    options?: ErrorOptions,
  ) {
    super('The GitHub notification model turn response could not be coordinated.', options);
  }
}

export interface GitHubNotificationModelTurnCoordinatorDependencies {
  candidates: Pick<GitHubNotificationReplyCandidateStore, 'begin' | 'cancel' | 'finish'>;
  dispatcher: Pick<GitHubNotificationModelTurnDispatcher, 'dispatch'>;
}

export interface GitHubNotificationModelTurnCoordinatorInput {
  config: OpenClawConfig;
  contract: GitHubNotificationTurnContract;
  createIfMissing?: boolean;
  ctxPayload: AssembledInboundReply['ctxPayload'];
  executionSurface: GitHubNotificationExecutionSurface;
  messageId: string;
  route: ResolvedNotificationRoute;
  signal?: AbortSignal;
  sourceId: string;
}

export interface GitHubNotificationModelTurnCoordinatorResult {
  dispatch: GitHubNotificationHostDispatchResult;
  finalPayloadCount: number;
  privateText: string;
  publication: GitHubNotificationModelTurnPublication;
}

function publication(
  candidates: readonly string[],
  intent: GitHubNotificationTurnContract['publicationIntent'],
): GitHubNotificationModelTurnPublication {
  if (candidates.length === 0) {
    return {
      status: 'withheld',
      code: 'github-notification-publication-candidate-missing',
    };
  }
  if (candidates.length !== 1) {
    return {
      status: 'withheld',
      code: 'github-notification-publication-candidate-duplicate',
    };
  }
  try {
    return {
      status: 'candidate',
      publicText: githubNotificationPublicationText(intent, [{ text: candidates[0] }]),
    };
  } catch (error) {
    return {
      status: 'withheld',
      code:
        error instanceof GitHubNotificationPublicationError
          ? error.code
          : 'github-notification-publication-validation-failed',
    };
  }
}

/** Coordinate one prepared model turn and its channel-owned response candidate. */
export default class GitHubNotificationModelTurnCoordinator {
  readonly #dependencies: GitHubNotificationModelTurnCoordinatorDependencies;

  constructor(dependencies: GitHubNotificationModelTurnCoordinatorDependencies) {
    this.#dependencies = dependencies;
  }

  async run(
    input: GitHubNotificationModelTurnCoordinatorInput,
  ): Promise<GitHubNotificationModelTurnCoordinatorResult> {
    const candidateIdentity = {
      agentId: input.route.agentId,
      conversationId: input.route.conversationId,
      identity: input.contract.identity,
      sourceId: input.sourceId,
    };
    const candidateTurn = await this.#dependencies.candidates.begin(candidateIdentity);
    let turnResult;
    try {
      turnResult = await this.#dependencies.dispatcher.dispatch({
        config: input.config,
        contract: input.contract,
        ...(input.createIfMissing === undefined ? {} : { createIfMissing: input.createIfMissing }),
        ctxPayload: input.ctxPayload,
        executionSurface: input.executionSurface,
        messageId: input.messageId,
        route: input.route,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      await this.#dependencies.candidates
        .cancel({ ...candidateIdentity, turnId: candidateTurn })
        .catch(() => undefined);
      throw error;
    }

    let publicCandidates: string[];
    try {
      publicCandidates = await this.#dependencies.candidates.finish({
        ...candidateIdentity,
        turnId: candidateTurn,
      });
    } catch (error) {
      throw new GitHubNotificationModelTurnCoordinatorError(
        error instanceof GitHubNotificationReplyCandidateStoreError &&
          error.code === 'reply-turn-prompt-selection-missing'
          ? 'github-notification-model-turn-prompt-selection-missing'
          : 'github-notification-model-turn-reply-candidate-failed',
        { cause: error },
      );
    }

    return {
      dispatch: turnResult.dispatch,
      finalPayloadCount: turnResult.finalPayloads.length,
      privateText: githubNotificationPrivateResponse(turnResult.finalPayloads),
      publication: publication(publicCandidates, input.contract.publicationIntent),
    };
  }
}
