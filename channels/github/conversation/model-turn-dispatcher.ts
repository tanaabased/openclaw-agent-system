import type {
  ChannelInboundTurnPlan,
  dispatchChannelInboundTurn,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import type ModelRoutingService from './model-routing-service.ts';
import {
  ModelRoutingError,
  type ModelRoutingExecution,
  type ModelRoutingObservation,
} from './model-routing.ts';

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
  modelRouting?: Pick<ModelRoutingService, 'apply' | 'recordExecution'>;
  dispatchChannelInboundTurn(
    input: ChannelInboundTurnPlan,
  ): ReturnType<typeof dispatchChannelInboundTurn>;
}

export interface GitHubNotificationModelTurnDispatchInput {
  afterRecord?: () => Promise<void>;
  config: OpenClawConfig;
  contract: Pick<GitHubNotificationTurnContract, 'instructions' | 'mode'> &
    Partial<Pick<GitHubNotificationTurnContract, 'identity'>>;
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
  routing?: ModelRoutingExecution;
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
    const ctxPayload = modelContext(input);
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    let routing: Awaited<ReturnType<ModelRoutingService['apply']>>;
    let observed: ModelRoutingObservation | undefined;
    let routingFailure: ModelRoutingError | undefined;
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
          routing = await this.#dependencies.modelRouting?.apply(input.route);
          if (
            routing &&
            input.executionSurface === 'cli-one-shot' &&
            input.contract.identity?.eventId === 'assignment'
          ) {
            ctxPayload.GroupSystemPrompt = [ctxPayload.GroupSystemPrompt, routing.guidance]
              .filter(Boolean)
              .join('\n\n');
          }
          await input.afterRecord?.();
        },
        cfg: input.config,
        channel: githubNotificationChannelId,
        ctxPayload,
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
          abortSignal: signal,
          onModelSelected(actual) {
            if (!routing) return;
            observed = {
              model: `${actual.provider}/${actual.model}`,
              ...(actual.thinkLevel ? { effort: actual.thinkLevel } : {}),
            };
            const observedModel = observed.model;
            const observedEffort = observed.effort;
            const matches =
              observedModel === routing.expected.model &&
              observedEffort === routing.expected.effort;
            if (!matches && (routing.strict || !routing.permittedModels.includes(observedModel))) {
              routingFailure = new ModelRoutingError(
                'github-notification-routing-effective-mismatch',
                'Native model or effort differed from the strict selection or its permitted continuation routes. Work was cancelled.',
              );
              controller.abort(routingFailure);
              throw routingFailure;
            }
          },
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
      throw (
        routingFailure ??
        (error instanceof GitHubNotificationModelTurnDispatcherError ||
        error instanceof ModelRoutingError
          ? error
          : new GitHubNotificationModelTurnDispatcherError(
              'github-notification-model-turn-dispatch-failed',
              { cause: error },
            ))
      );
    }
    if (routingFailure) throw routingFailure;
    if (!result.dispatched || result.routeSessionKey !== input.route.sessionKey) {
      throw new GitHubNotificationModelTurnDispatcherError(
        'github-notification-model-turn-dispatch-unconfirmed',
      );
    }
    let execution: ModelRoutingExecution | undefined;
    if (routing) {
      execution = observed?.effort
        ? {
            requested: routing.expected,
            observed,
            status:
              observed.model === routing.expected.model &&
              observed.effort === routing.expected.effort
                ? 'verified'
                : 'continued',
          }
        : {
            requested: routing.expected,
            ...(observed ? { observed } : {}),
            status: 'unverified',
          };
      await this.#dependencies.modelRouting!.recordExecution(input.route, execution);
    }
    return {
      dispatch: result.dispatchResult,
      finalPayloads,
      ...(execution ? { routing: execution } : {}),
    };
  }
}
