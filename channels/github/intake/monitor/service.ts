import { listAgentIds } from 'openclaw/plugin-sdk/agent-runtime';
import { sleepWithAbort } from 'openclaw/plugin-sdk/infra-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentManifestService from '../../../../manifest/service.ts';
import type GitHubAccountClient from '../../../../core/github-account-client.ts';
import type { Logger } from '../../../../core/logger.ts';
import {
  githubNotificationRetirementItemKeys,
  type GitHubNotificationMonitorState,
} from './state.ts';
import type { GitHubNotificationItemSelector } from '../../provider/work-item.ts';
import type { GitHubNotificationExecutionSurface } from '../../conversation/execution.ts';
import type GitHubNotificationMonitorCycleLeaseStore from './cycle-lease.ts';
import type GitHubNotificationMonitorStateStore from './state-store.ts';
import { pollGitHubNotifications } from './poller.ts';
import type NotificationRoutingService from '../../routing/service.ts';
import GitHubWorkEventClient from '../../provider/work-event-client.ts';
import { githubNotificationDiagnostic } from './diagnostic.ts';
import createGitHubNotificationFailureState from './failure-state.ts';
import { pendingGitHubNotificationItemKeys } from './item-queries.ts';
import GitHubNotificationMonitorReconciler, {
  type GitHubNotificationAssignmentReconciler,
  type GitHubNotificationCommentReconciler,
} from './reconciler.ts';

const schedulerIntervalMs = 30_000;

export interface GitHubNotificationMonitorServiceDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  assignmentOrchestrator: GitHubNotificationAssignmentReconciler;
  commentOrchestrator?: GitHubNotificationCommentReconciler;
  clock?: () => number;
  cycleLeaseStore: Pick<GitHubNotificationMonitorCycleLeaseStore, 'acquire'>;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  random?: () => number;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  routingService: Pick<NotificationRoutingService, 'inspect'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'> &
    Partial<Pick<GitHubNotificationMonitorStateStore, 'load' | 'remove'>>;
}

export interface GitHubNotificationMonitorRunOptions {
  agentId?: string;
  bypassInterval?: boolean;
  executionSurface?: GitHubNotificationExecutionSurface;
  selector?: GitHubNotificationItemSelector;
  signal?: AbortSignal;
  waitForLeaseMs?: number;
}

export interface GitHubNotificationMonitorRunResult {
  agentId: string;
  approved?: number;
  baseline?: number;
  baselineAt?: number;
  baselineEstablished?: boolean;
  code: string;
  diagnosticCode?: string;
  duplicates?: number;
  lastSuccessfulPollAt?: number;
  nextPollAt?: number;
  rejected?: number;
  retryAt?: number;
  retired?: number;
  status: 'completed' | 'failed' | 'skipped';
}

export type GitHubNotificationMonitorCycleListener = (
  result: GitHubNotificationMonitorRunResult,
) => Promise<void> | void;

function monitorStateMetadata(state: GitHubNotificationMonitorState | undefined) {
  if (!state) return {};
  return {
    ...(state.baselineAt === undefined ? {} : { baselineAt: state.baselineAt }),
    ...(state.diagnosticCode === undefined ? {} : { diagnosticCode: state.diagnosticCode }),
    ...(state.lastSuccessfulPollAt === undefined
      ? {}
      : { lastSuccessfulPollAt: state.lastSuccessfulPollAt }),
    ...(state.nextPollAt === undefined ? {} : { nextPollAt: state.nextPollAt }),
  };
}

function isRoutingDiagnostic(code: string | undefined): boolean {
  return code?.startsWith('notification-routing-') === true;
}

/** Schedule route-gated GitHub assignment polls and recoverable local intake. */
export default class GitHubNotificationMonitorService {
  readonly #dependencies: GitHubNotificationMonitorServiceDependencies;
  readonly #inFlight = new Map<string, Promise<GitHubNotificationMonitorRunResult>>();
  readonly #reconciler: GitHubNotificationMonitorReconciler;

  constructor(dependencies: GitHubNotificationMonitorServiceDependencies) {
    this.#dependencies = dependencies;
    this.#reconciler = new GitHubNotificationMonitorReconciler({
      assignmentOrchestrator: dependencies.assignmentOrchestrator,
      ...(dependencies.commentOrchestrator === undefined
        ? {}
        : { commentOrchestrator: dependencies.commentOrchestrator }),
      logger: dependencies.logger,
      stateStore: dependencies.stateStore,
    });
  }

  async runOnce(
    input: AbortSignal | GitHubNotificationMonitorRunOptions = {},
  ): Promise<GitHubNotificationMonitorRunResult[]> {
    const options: GitHubNotificationMonitorRunOptions =
      'aborted' in input ? { signal: input } : input;
    const config = await this.#dependencies.readConfig();
    const agentIds = options.agentId ? [options.agentId] : listAgentIds(config);
    const results: GitHubNotificationMonitorRunResult[] = [];
    for (const agentId of agentIds) {
      if (options.signal?.aborted) break;
      results.push(await this.#runAgent(agentId, options));
    }
    return results;
  }

  /** Run one channel account's scheduler until OpenClaw stops its lifecycle. */
  async runAccount(
    agentId: string,
    signal: AbortSignal,
    onCycle?: GitHubNotificationMonitorCycleListener,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const [result] = await this.runOnce({ agentId, signal });
        if (result) await onCycle?.(result);
      } catch {
        this.#dependencies.logger.error(
          `github-notifications: monitor cycle failed agent=${agentId} code=github-notification-monitor-cycle-failed`,
        );
      }
      try {
        await sleepWithAbort(schedulerIntervalMs, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }

  async #runAgent(
    agentId: string,
    options: GitHubNotificationMonitorRunOptions,
  ): Promise<GitHubNotificationMonitorRunResult> {
    const runKey = options.selector
      ? `${agentId}:${options.selector.repository.toLowerCase()}:${options.selector.itemType}:${options.selector.number}`
      : agentId;
    const existing = this.#inFlight.get(runKey);
    if (existing) return existing;
    const current = this.#runAgentWithLease(agentId, options).finally(() => {
      if (this.#inFlight.get(runKey) === current) this.#inFlight.delete(runKey);
    });
    this.#inFlight.set(runKey, current);
    return current;
  }

  async #runAgentWithLease(
    agentId: string,
    options: GitHubNotificationMonitorRunOptions,
  ): Promise<GitHubNotificationMonitorRunResult> {
    let acquisition;
    try {
      acquisition = await this.#dependencies.cycleLeaseStore.acquire(agentId, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.waitForLeaseMs === undefined ? {} : { waitMs: options.waitForLeaseMs }),
      });
    } catch {
      this.#dependencies.logger.warn(
        `github-notifications: cycle lease failed agent=${agentId} code=github-notification-cycle-lease-failed`,
      );
      return {
        agentId,
        code: 'github-notification-cycle-lease-failed',
        status: 'failed',
      };
    }
    if (acquisition.status !== 'acquired') {
      return {
        agentId,
        code:
          acquisition.status === 'aborted'
            ? 'github-notification-cycle-aborted'
            : 'github-notification-cycle-busy',
        status: 'skipped',
      };
    }
    let result: GitHubNotificationMonitorRunResult;
    try {
      result = await this.#executeAgent(agentId, options);
    } catch (error) {
      await acquisition.lease.release().catch(() => undefined);
      throw error;
    }
    try {
      await acquisition.lease.release();
    } catch {
      this.#dependencies.logger.warn(
        `github-notifications: cycle lease release failed agent=${agentId} code=github-notification-cycle-lease-release-failed`,
      );
      return {
        agentId,
        code: 'github-notification-cycle-lease-release-failed',
        status: 'failed',
      };
    }
    return result;
  }

  async #executeAgent(
    agentId: string,
    options: GitHubNotificationMonitorRunOptions,
  ): Promise<GitHubNotificationMonitorRunResult> {
    const { bypassInterval = false, executionSurface = 'gateway', signal } = options;
    let workspaceDir: string | undefined;
    try {
      const loaded = await this.#dependencies.manifestService.loadForAgentId(agentId, 'service');
      if (loaded.status !== 'loaded') {
        return {
          agentId,
          code: `github-notification-manifest-${loaded.status}`,
          status: 'skipped',
        };
      }
      workspaceDir = loaded.scope.workspaceDir;
      const now = (this.#dependencies.clock ?? Date.now)();
      const loadedState = this.#dependencies.stateStore.load
        ? await this.#dependencies.stateStore.load(agentId)
        : await this.#dependencies.stateStore
            .read(agentId)
            .then((state) =>
              state ? ({ state, status: 'ready' } as const) : ({ status: 'missing' } as const),
            );
      let current = loadedState.status === 'missing' ? undefined : loadedState.state;
      const notifications = loaded.manifest.github?.notifications;
      if (!notifications) {
        await this.#reconciler.retireDisabledAssignments(agentId, current, now, signal);
        return { agentId, code: 'github-notification-disabled', status: 'skipped' };
      }
      const pendingItemKeys = pendingGitHubNotificationItemKeys(current, options.selector);
      const intervalDeferred = current?.nextPollAt !== undefined && current.nextPollAt > now;
      const pollDeferred =
        intervalDeferred && (!bypassInterval || (current?.failureCount ?? 0) > 0);
      const routingBackoff =
        pollDeferred &&
        (current?.failureCount ?? 0) > 0 &&
        isRoutingDiagnostic(current?.diagnosticCode);
      if (pollDeferred && (current?.failureCount ?? 0) > 0 && !routingBackoff) {
        return {
          agentId,
          code: 'github-notification-backoff-active',
          ...monitorStateMetadata(current),
          retryAt: current?.nextPollAt,
          status: 'skipped',
        };
      }
      if (pollDeferred && pendingItemKeys.length === 0 && !routingBackoff) {
        return {
          agentId,
          code: 'github-notification-interval-active',
          ...monitorStateMetadata(current),
          status: 'skipped',
        };
      }

      const route = await this.#dependencies.routingService.inspect({
        agentId,
        enabled: true,
        workspaceDir,
      });
      if (route.kind !== 'noop' || route.code !== 'notification-routing-ready') {
        if (routingBackoff) {
          return {
            agentId,
            code: 'github-notification-backoff-active',
            ...monitorStateMetadata(current),
            retryAt: current?.nextPollAt,
            status: 'skipped',
          };
        }
        await this.#reconciler.reconcileAssignments(
          agentId,
          githubNotificationRetirementItemKeys(current),
          signal,
        );
        const failed = await this.#saveFailure(
          agentId,
          workspaceDir,
          await this.#dependencies.stateStore.read(agentId),
          now,
          route.code,
        );
        return {
          agentId,
          code: route.code,
          ...monitorStateMetadata(failed),
          retryAt: failed.nextPollAt,
          status: 'failed',
        };
      }

      if (routingBackoff && current) {
        current = structuredClone(current);
        delete current.diagnosticCode;
        current.failureCount = 0;
        current.nextPollAt = now;
        await this.#dependencies.stateStore.write(current);
      } else if (pollDeferred) {
        await this.#reconciler.reconcileAssignments(agentId, pendingItemKeys, signal);
        const commentFailure = await this.#reconciler.reconcileCommentsSafely(
          agentId,
          options.selector,
          executionSurface,
          signal,
        );
        await this.#reconciler.reconcileAssignmentResponses(
          agentId,
          options.selector,
          executionSurface,
          signal,
        );
        if (commentFailure) {
          return {
            agentId,
            code: commentFailure.code,
            ...monitorStateMetadata(current),
            status: 'failed',
          };
        }
        return {
          agentId,
          code: 'github-notification-pending-reconciled',
          ...monitorStateMetadata(current),
          status: 'completed',
        };
      }

      const connected = await this.#dependencies.accountClient.connect(
        { manifest: loaded.manifest, workspaceDir },
        'service',
        signal,
      );
      const client = new GitHubWorkEventClient(connected);
      const result = await pollGitHubNotifications({
        agentId,
        client,
        configuration: notifications,
        now,
        ...(options.selector === undefined ? {} : { selector: options.selector }),
        ...(current === undefined ? {} : { state: current }),
        workspaceDir,
      });
      const intervalMs = notifications.intervalMinutes * 60 * 1000;
      const jitter = 0.9 + (this.#dependencies.random ?? Math.random)() * 0.2;
      const rateReset = client.rateLimit.remaining === 0 ? (client.rateLimit.resetAt ?? 0) : 0;
      result.state.diagnosticCode = undefined;
      result.state.failureCount = 0;
      result.state.lastPollAt = now;
      result.state.lastSuccessfulPollAt = now;
      result.state.nextPollAt = Math.max(now + Math.floor(intervalMs * jitter), rateReset + 1_000);
      await this.#dependencies.stateStore.write(result.state);
      await this.#reconciler.reconcileAssignments(
        agentId,
        pendingGitHubNotificationItemKeys(result.state, options.selector),
        signal,
      );
      const commentFailure = await this.#reconciler.reconcileCommentsSafely(
        agentId,
        options.selector,
        executionSurface,
        signal,
      );
      await this.#reconciler.reconcileAssignmentResponses(
        agentId,
        options.selector,
        executionSurface,
        signal,
      );
      if (commentFailure) {
        return {
          agentId,
          approved: result.approved,
          baseline: result.baseline,
          baselineAt: result.state.baselineAt,
          baselineEstablished: result.baselineEstablished,
          code: commentFailure.code,
          duplicates: result.duplicates,
          lastSuccessfulPollAt: result.state.lastSuccessfulPollAt,
          nextPollAt: result.state.nextPollAt,
          rejected: result.rejected,
          retired: result.retired,
          status: 'failed',
        };
      }
      const code = result.baselineEstablished
        ? 'github-notification-baseline-established'
        : 'github-notification-poll-complete';
      this.#dependencies.logger.info(
        `github-notifications: poll complete agent=${agentId} code=${code} baselineEstablished=${result.baselineEstablished} baselineItems=${result.baseline} approved=${result.approved} rejected=${result.rejected} duplicate=${result.duplicates} retired=${result.retired}`,
      );
      return {
        agentId,
        approved: result.approved,
        baseline: result.baseline,
        baselineAt: result.state.baselineAt,
        baselineEstablished: result.baselineEstablished,
        code,
        duplicates: result.duplicates,
        lastSuccessfulPollAt: result.state.lastSuccessfulPollAt,
        nextPollAt: result.state.nextPollAt,
        rejected: result.rejected,
        retired: result.retired,
        status: 'completed',
      };
    } catch (error) {
      if (signal?.aborted) {
        return {
          agentId,
          code: 'github-notification-cycle-aborted',
          status: 'skipped',
        };
      }
      const now = (this.#dependencies.clock ?? Date.now)();
      const diagnostic = githubNotificationDiagnostic(error);
      try {
        if (workspaceDir) {
          const current = await this.#dependencies.stateStore.read(agentId);
          const failed = await this.#saveFailure(
            agentId,
            workspaceDir,
            current,
            now,
            diagnostic.code,
            diagnostic.retryAt,
          );
          this.#dependencies.logger.warn(
            `github-notifications: poll deferred agent=${agentId} code=${diagnostic.code}`,
          );
          return {
            agentId,
            code: diagnostic.code,
            ...monitorStateMetadata(failed),
            retryAt: failed.nextPollAt,
            status: 'failed',
          };
        }
      } catch {
        this.#dependencies.logger.error(
          `github-notifications: monitor state unsafe agent=${agentId} code=github-notification-state-unsafe`,
        );
        return {
          agentId,
          code: 'github-notification-state-unsafe',
          status: 'failed',
        };
      }
      this.#dependencies.logger.warn(
        `github-notifications: poll deferred agent=${agentId} code=${diagnostic.code}`,
      );
      return { agentId, code: diagnostic.code, status: 'failed' };
    }
  }

  async #saveFailure(
    agentId: string,
    workspaceDir: string,
    current: GitHubNotificationMonitorState | undefined,
    now: number,
    code: string,
    retryAt?: number,
  ): Promise<GitHubNotificationMonitorState> {
    const state = createGitHubNotificationFailureState({
      agentId,
      code,
      current,
      now,
      random: this.#dependencies.random ?? Math.random,
      ...(retryAt === undefined ? {} : { retryAt }),
      workspaceDir,
    });
    await this.#dependencies.stateStore.write(state);
    return state;
  }
}
