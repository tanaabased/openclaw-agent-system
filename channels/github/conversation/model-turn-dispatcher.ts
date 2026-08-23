import {
  dispatchChannelInboundReply,
  type AssembledInboundReply,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';

import { githubNotificationChannelId, type ResolvedNotificationRoute } from '../routing/routing.ts';
import {
  githubNotificationReplyCleanupOptions,
  type GitHubNotificationExecutionSurface,
} from './execution.ts';
import {
  githubNotificationTurnDispatchOptions,
  type GitHubNotificationTurnContract,
} from './turn-contract.ts';

type GitHubNotificationHostDispatchResult = Extract<
  Awaited<ReturnType<typeof dispatchChannelInboundReply>>,
  { dispatched: true }
>['dispatchResult'];

export type GitHubNotificationModelTurnDispatcherErrorCode =
  | 'github-notification-model-turn-dispatch-failed'
  | 'github-notification-model-turn-dispatch-unconfirmed'
  | 'github-notification-model-turn-session-missing'
  | 'github-notification-model-turn-session-recording-failed';

export class GitHubNotificationModelTurnDispatcherError extends Error {
  override name = 'GitHubNotificationModelTurnDispatcherError';

  constructor(
    readonly code: GitHubNotificationModelTurnDispatcherErrorCode,
    options?: ErrorOptions,
  ) {
    super('The GitHub notification model turn could not be dispatched.', options);
  }
}

export interface GitHubNotificationModelTurnDispatcherDependencies {
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

export interface GitHubNotificationModelTurnDispatchInput {
  config: OpenClawConfig;
  contract: Pick<GitHubNotificationTurnContract, 'mode'>;
  ctxPayload: AssembledInboundReply['ctxPayload'];
  executionSurface: GitHubNotificationExecutionSurface;
  messageId: string;
  route: ResolvedNotificationRoute;
  signal?: AbortSignal;
}

export interface GitHubNotificationModelTurnDispatchResult {
  dispatch: GitHubNotificationHostDispatchResult;
  finalPayloads: ReplyPayload[];
}

/** Dispatch one resolved model turn through OpenClaw's host-owned inbound lifecycle. */
export default class GitHubNotificationModelTurnDispatcher {
  readonly #dependencies: GitHubNotificationModelTurnDispatcherDependencies;

  constructor(dependencies: GitHubNotificationModelTurnDispatcherDependencies) {
    this.#dependencies = dependencies;
  }

  async dispatch(
    input: GitHubNotificationModelTurnDispatchInput,
  ): Promise<GitHubNotificationModelTurnDispatchResult> {
    const finalPayloads: ReplyPayload[] = [];
    const turnDispatch = githubNotificationTurnDispatchOptions(input.contract);
    let sessionRecordTask: Promise<unknown> | undefined;
    let result;
    try {
      result = await dispatchChannelInboundReply({
        accountId: input.route.accountId,
        agentId: input.route.agentId,
        afterRecord: async () => {
          if (!sessionRecordTask) {
            throw new GitHubNotificationModelTurnDispatcherError(
              'github-notification-model-turn-session-recording-failed',
            );
          }
          if (!(await sessionRecordTask)) {
            throw new GitHubNotificationModelTurnDispatcherError(
              'github-notification-model-turn-session-missing',
            );
          }
        },
        cfg: input.config,
        channel: githubNotificationChannelId,
        ctxPayload: input.ctxPayload,
        delivery: {
          async deliver(payload, info) {
            if (info.kind === 'final') finalPayloads.push(payload);
            return { visibleReplySent: false };
          },
        },
        dispatchReplyWithBufferedBlockDispatcher:
          this.#dependencies.dispatchReplyWithBufferedBlockDispatcher,
        messageId: input.messageId,
        record: {
          createIfMissing: false,
          onRecordError(error) {
            throw new GitHubNotificationModelTurnDispatcherError(
              'github-notification-model-turn-session-recording-failed',
              { cause: error },
            );
          },
          trackSessionMetaTask(task) {
            sessionRecordTask = task;
          },
        },
        recordInboundSession: this.#dependencies.recordInboundSession,
        replyOptions: {
          ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
          ...githubNotificationReplyCleanupOptions(input.executionSurface),
          commentaryPayloadsEnabled: true,
          ...turnDispatch.replyOptions,
          sourceReplyDeliveryMode: 'automatic',
          suppressDefaultToolProgressMessages: true,
          suppressTyping: true,
        },
        routeSessionKey: input.route.sessionKey,
        storePath: resolveStorePath(input.config.session?.store, {
          agentId: input.route.agentId,
        }),
        ...(turnDispatch.toolsAllow === undefined ? {} : { toolsAllow: turnDispatch.toolsAllow }),
      });
    } catch (error) {
      throw error instanceof GitHubNotificationModelTurnDispatcherError
        ? error
        : new GitHubNotificationModelTurnDispatcherError(
            'github-notification-model-turn-dispatch-failed',
            { cause: error },
          );
    }
    if (!result.dispatched || result.routeSessionKey !== input.route.sessionKey) {
      throw new GitHubNotificationModelTurnDispatcherError(
        'github-notification-model-turn-dispatch-unconfirmed',
      );
    }
    return { dispatch: result.dispatchResult, finalPayloads };
  }
}
