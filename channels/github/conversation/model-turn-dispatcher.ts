import type {
  ChannelInboundTurnPlan,
  dispatchChannelInboundTurn,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { githubNotificationChannelId, type ResolvedNotificationRoute } from '../routing/routing.ts';
import {
  githubNotificationReplyCleanupOptions,
  type GitHubNotificationExecutionSurface,
} from './execution.ts';
import {
  githubNotificationTurnDispatchOptions,
  type GitHubNotificationTurnContract,
} from './turn-contract.ts';

export type GitHubNotificationHostDispatchResult = Extract<
  Awaited<ReturnType<typeof dispatchChannelInboundTurn>>,
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
  dispatchChannelInboundTurn(
    input: ChannelInboundTurnPlan,
  ): ReturnType<typeof dispatchChannelInboundTurn>;
}

export interface GitHubNotificationModelTurnDispatchInput {
  afterRecord?: () => Promise<void>;
  config: OpenClawConfig;
  contract: Pick<GitHubNotificationTurnContract, 'instructions' | 'mode'>;
  createIfMissing?: boolean;
  ctxPayload: ChannelInboundTurnPlan['ctxPayload'];
  executionSurface: GitHubNotificationExecutionSurface;
  messageId: string;
  route: ResolvedNotificationRoute;
  signal?: AbortSignal;
}

export interface GitHubNotificationModelTurnDispatchResult {
  dispatch: GitHubNotificationHostDispatchResult;
  finalPayloads: ReplyPayload[];
}

function modelContext(
  input: GitHubNotificationModelTurnDispatchInput,
): ChannelInboundTurnPlan['ctxPayload'] {
  if (input.executionSurface !== 'cli-one-shot') return input.ctxPayload;
  const existing = input.ctxPayload.GroupSystemPrompt?.trim();
  return {
    ...input.ctxPayload,
    GroupSystemPrompt: [existing, input.contract.instructions].filter(Boolean).join('\n\n'),
  };
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
      result = await this.#dependencies.dispatchChannelInboundTurn({
        accountId: input.route.accountId,
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
          await input.afterRecord?.();
        },
        cfg: input.config,
        channel: githubNotificationChannelId,
        ctxPayload: modelContext(input),
        delivery: {
          async deliver(payload, info) {
            if (info.kind === 'final') finalPayloads.push(payload);
            return {
              suppression: { reason: 'channel_transform' },
              visibleReplySent: false,
            };
          },
        },
        messageId: input.messageId,
        record: {
          createIfMissing: input.createIfMissing ?? false,
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
        replyOptions: {
          ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
          ...githubNotificationReplyCleanupOptions(input.executionSurface),
          commentaryPayloadsEnabled: true,
          ...turnDispatch.replyOptions,
          sourceReplyDeliveryMode: 'automatic',
          suppressDefaultToolProgressMessages: true,
          suppressTyping: true,
        },
        route: {
          agentId: input.route.agentId,
          sessionKey: input.route.sessionKey,
        },
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
