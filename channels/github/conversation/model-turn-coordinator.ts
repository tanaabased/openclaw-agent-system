import type { AssembledInboundReply } from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { Logger } from '../../../core/logger.ts';
import {
  GitHubNotificationReplyCandidateStoreError,
  type default as GitHubNotificationReplyCandidateStore,
} from '../publication/reply-candidate-store.ts';
import {
  GitHubNotificationPublicationError,
  githubNotificationPublicationText,
  type GitHubNotificationPublicationSafetyCategory,
} from '../publication/publication.ts';
import type { ResolvedNotificationRoute } from '../routing/routing.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type GitHubNotificationModelTurnDispatcher from './model-turn-dispatcher.ts';
import type { GitHubNotificationHostDispatchResult } from './model-turn-dispatcher.ts';
import { githubNotificationPrivateResponse } from './private-response.ts';
import type { GitHubNotificationTurnContract } from './turn-contract.ts';

export type GitHubNotificationModelTurnPublication =
  | { status: 'candidate'; publicText: string }
  | {
      status: 'withheld';
      code: string;
      safetyCategory?: GitHubNotificationPublicationSafetyCategory;
    };

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
  logger: Pick<Logger, 'info' | 'warn'>;
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
      ...(error instanceof GitHubNotificationPublicationError && error.safetyCategory
        ? { safetyCategory: error.safetyCategory }
        : {}),
    };
  }
}

function diagnosticCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[a-z0-9-]+$/u.test(error.code)
  ) {
    return error.code;
  }
  return 'unclassified';
}

function turnDetails(input: GitHubNotificationModelTurnCoordinatorInput): string {
  return [
    `agent=${input.route.agentId}`,
    `lifecycle=${input.contract.identity.lifecycleId}`,
    `mode=${input.contract.identity.modeId}`,
    `event=${input.contract.identity.eventId}`,
    `surface=${input.executionSurface}`,
  ].join(' ');
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
    const startedAt = Date.now();
    const details = turnDetails(input);
    this.#dependencies.logger.info(`github-notifications: model turn started ${details}`);
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
      this.#dependencies.logger.warn(
        [
          'github-notifications: model turn failed',
          details,
          'phase=dispatch',
          `code=${diagnosticCode(error)}`,
          `aborted=${Boolean(input.signal?.aborted)}`,
          `duration-ms=${Date.now() - startedAt}`,
        ].join(' '),
      );
      throw error;
    }

    let publicCandidates: string[];
    try {
      publicCandidates = await this.#dependencies.candidates.finish({
        ...candidateIdentity,
        turnId: candidateTurn,
      });
    } catch (error) {
      this.#dependencies.logger.warn(
        [
          'github-notifications: model turn failed',
          details,
          'phase=candidate-handoff',
          `code=${diagnosticCode(error)}`,
          `final-payloads=${turnResult.finalPayloads.length}`,
          `block=${turnResult.dispatch.counts.block}`,
          `final=${turnResult.dispatch.counts.final}`,
          `tool=${turnResult.dispatch.counts.tool}`,
          `queued-final=${turnResult.dispatch.queuedFinal}`,
          `aborted=${Boolean(input.signal?.aborted)}`,
          `duration-ms=${Date.now() - startedAt}`,
        ].join(' '),
      );
      throw new GitHubNotificationModelTurnCoordinatorError(
        error instanceof GitHubNotificationReplyCandidateStoreError &&
          error.code === 'reply-turn-prompt-selection-missing'
          ? 'github-notification-model-turn-prompt-selection-missing'
          : 'github-notification-model-turn-reply-candidate-failed',
        { cause: error },
      );
    }

    const responsePublication = publication(publicCandidates, input.contract.publicationIntent);
    const completion = [
      'github-notifications: model turn completed',
      details,
      `final-payloads=${turnResult.finalPayloads.length}`,
      `block=${turnResult.dispatch.counts.block}`,
      `final=${turnResult.dispatch.counts.final}`,
      `tool=${turnResult.dispatch.counts.tool}`,
      `queued-final=${turnResult.dispatch.queuedFinal}`,
      `candidates=${publicCandidates.length}`,
      `publication=${responsePublication.status}`,
      ...(responsePublication.status === 'withheld' ? [`code=${responsePublication.code}`] : []),
      ...(responsePublication.status === 'withheld' && responsePublication.safetyCategory
        ? [`safety=${responsePublication.safetyCategory}`]
        : []),
      `aborted=${Boolean(input.signal?.aborted)}`,
      `duration-ms=${Date.now() - startedAt}`,
    ].join(' ');
    if (responsePublication.status === 'withheld') {
      this.#dependencies.logger.warn(completion);
    } else {
      this.#dependencies.logger.info(completion);
    }

    return {
      dispatch: turnResult.dispatch,
      finalPayloadCount: turnResult.finalPayloads.length,
      privateText: githubNotificationPrivateResponse(turnResult.finalPayloads),
      publication: responsePublication,
    };
  }
}
