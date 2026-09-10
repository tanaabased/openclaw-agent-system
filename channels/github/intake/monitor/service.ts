import { listAgentIds } from 'openclaw/plugin-sdk/agent-scope-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type { ConversationHookFinding } from '../../../../core/conversation-hook-access.ts';
import type AgentManifestService from '../../../../manifest/service.ts';
import type GitHubAccountClient from '../../../../core/github-account-client.ts';
import type { Logger } from '../../../../core/logger.ts';
import abortableDelay from '../../../../utils/abortable-delay.ts';
import {
  githubNotificationRetirementItemKeys,
  type GitHubNotificationMonitorState,
} from './state.ts';
import type { GitHubNotificationItemSelector } from '../../provider/work-item.ts';
import type { GitHubNotificationExecutionSurface } from '../../conversation/execution.ts';
import type GitHubNotificationMonitorCycleLeaseStore from './cycle-lease.ts';
import type GitHubNotificationMonitorStateStore from './state-store.ts';
import { checkpointGitHubNotificationPoll } from './state-checkpoint.ts';
import { pollGitHubNotifications } from './poller.ts';
import type NotificationRoutingService from '../../routing/service.ts';
import GitHubWorkEventClient from '../../provider/work-event-client.ts';
import { githubNotificationDiagnostic } from './diagnostic.ts';
import createGitHubNotificationFailureState from './failure-state.ts';
import {
  pendingGitHubNotificationItemKeys,
  preparedGitHubNotificationIssueItemKeys,
} from './item-queries.ts';
import GitHubNotificationMonitorReconciler, {
  type GitHubNotificationAssignmentReconciler,
  type GitHubNotificationCommentReconciler,
} from './reconciler.ts';

const schedulerIntervalMs = 30_000;

export interface GitHubNotificationMonitorServiceDependencies {
  inspectReadiness(): ConversationHookFinding;
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  assignmentOrchestrator: GitHubNotificationAssignmentReconciler;
  commentOrchestrator?: GitHubNotificationCommentReconciler;
  clock?: () => number;
  cycleLeaseStore: Pick<GitHubNotificationMonitorCycleLeaseStore, 'acquire'>;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  random?: () => number;
  sleep?: typeof abortableDelay;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  routingService: Pick<NotificationRoutingService, 'inspect'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'update'> &
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

function isPrerequisiteDiagnostic(code: string | undefined): boolean {
  return (
    code?.startsWith('notification-routing-') === true ||
    code?.startsWith('github-notification-hook-') === true ||
    code === 'github-notification-prompt-injection-denied'
  );
}

function completedExecutionResult(result: GitHubNotificationMonitorRunResult) {
  return result.code === 'github-notification-execution-pending'
    ? { ...result, code: 'github-notification-pending-reconciled' }
    : result;
}

/** Schedule route-gated GitHub assignment polls and recoverable local intake. */
export default class GitHubNotificationMonitorService {
  readonly #dependencies: GitHubNotificationMonitorServiceDependencies;
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
      const result = await this.#pollAgent(agentId, options);
      if (!this.#needsExecution(result)) {
        results.push(result);
        continue;
      }
      const itemKeys = await this.#executionItemKeys(agentId, options, result);
      const settled = await Promise.allSettled(
        itemKeys.map((itemKey) => this.#runExecution(agentId, options, result, itemKey)),
      );
      const executions = settled.map((execution) => {
        if (execution.status === 'rejected') throw execution.reason;
        return execution.value;
      });
      results.push(
        executions.find((execution) => execution.status === 'failed') ??
          executions.find((execution) => execution.status === 'skipped') ??
          executions[0] ??
          completedExecutionResult(result),
      );
    }
    return results;
  }

  /** Run one channel account's scheduler until OpenClaw stops its lifecycle. */
  async runAccount(
    agentId: string,
    signal: AbortSignal,
    onCycle?: GitHubNotificationMonitorCycleListener,
  ): Promise<void> {
    const controller = new AbortController();
    const accountSignal = AbortSignal.any([signal, controller.signal]);
    const executions = new Map<string, Promise<void>>();
    try {
      while (!accountSignal.aborted) {
        try {
          const result = await this.#pollAgent(agentId, { signal: accountSignal });
          if (!accountSignal.aborted && this.#needsExecution(result)) {
            const options = { signal: accountSignal };
            const itemKeys = await this.#executionItemKeys(agentId, options, result);
            for (const itemKey of itemKeys) {
              if (accountSignal.aborted) break;
              if (executions.has(itemKey)) continue;
              const execution = this.#runExecution(agentId, options, result, itemKey)
                .then((completed) => {
                  if (completed.status === 'failed') {
                    this.#dependencies.logger.warn(
                      `github-notifications: executor failed agent=${agentId} code=${completed.code}`,
                    );
                  }
                })
                .catch(() => {
                  this.#dependencies.logger.error(
                    `github-notifications: executor failed agent=${agentId} code=github-notification-execution-failed`,
                  );
                })
                .finally(() => {
                  executions.delete(itemKey);
                });
              executions.set(itemKey, execution);
            }
          }
          await onCycle?.(result);
        } catch {
          this.#dependencies.logger.error(
            `github-notifications: monitor cycle failed agent=${agentId} code=github-notification-monitor-cycle-failed`,
          );
        }
        try {
          await (this.#dependencies.sleep ?? abortableDelay)(schedulerIntervalMs, accountSignal);
        } catch (error) {
          if (!accountSignal.aborted) throw error;
        }
      }
    } finally {
      // the account owns every worker through shutdown; no detached work survives it.
      controller.abort();
      await Promise.allSettled(executions.values());
    }
  }

  #needsExecution(result: GitHubNotificationMonitorRunResult): boolean {
    return (
      result.status === 'completed' ||
      result.code === 'github-notification-disabled' ||
      isPrerequisiteDiagnostic(result.code)
    );
  }

  #pollAgent(agentId: string, options: GitHubNotificationMonitorRunOptions) {
    return this.#withLease(agentId, options, 'poll', () => this.#poll(agentId, options));
  }

  async #executionItemKeys(
    agentId: string,
    options: GitHubNotificationMonitorRunOptions,
    result: GitHubNotificationMonitorRunResult,
  ): Promise<string[]> {
    const state = await this.#dependencies.stateStore.read(agentId);
    if (result.code === 'github-notification-disabled' || isPrerequisiteDiagnostic(result.code)) {
      return githubNotificationRetirementItemKeys(state);
    }
    return [
      ...new Set([
        ...pendingGitHubNotificationItemKeys(state, options.selector),
        ...preparedGitHubNotificationIssueItemKeys(state, options.selector),
      ]),
    ].sort();
  }

  #runExecution(
    agentId: string,
    options: GitHubNotificationMonitorRunOptions,
    result: GitHubNotificationMonitorRunResult,
    itemKey: string,
  ) {
    return this.#withLease(
      agentId,
      options,
      'execution',
      () => this.#execute(agentId, options, result, itemKey),
      result,
      itemKey,
    );
  }

  async #withLease(
    agentId: string,
    options: GitHubNotificationMonitorRunOptions,
    scope: 'execution' | 'poll',
    operation: () => Promise<GitHubNotificationMonitorRunResult>,
    previous?: GitHubNotificationMonitorRunResult,
    itemKey?: string,
  ): Promise<GitHubNotificationMonitorRunResult> {
    const label = scope === 'poll' ? 'cycle' : 'execution';
    let acquisition;
    try {
      acquisition = await this.#dependencies.cycleLeaseStore.acquire(agentId, {
        scope,
        ...(itemKey === undefined ? {} : { itemKey }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.waitForLeaseMs === undefined ? {} : { waitMs: options.waitForLeaseMs }),
      });
    } catch {
      this.#dependencies.logger.warn(
        `github-notifications: ${label} lease failed agent=${agentId} code=github-notification-${label}-lease-failed`,
      );
      return {
        agentId,
        code: `github-notification-${label}-lease-failed`,
        status: 'failed',
      };
    }
    if (acquisition.status !== 'acquired') {
      return {
        ...previous,
        agentId,
        code:
          acquisition.status === 'aborted'
            ? 'github-notification-cycle-aborted'
            : `github-notification-${label}-busy`,
        status: 'skipped',
      };
    }
    let result: GitHubNotificationMonitorRunResult;
    try {
      result = await operation();
    } catch (error) {
      await acquisition.lease.release().catch(() => undefined);
      throw error;
    }
    try {
      await acquisition.lease.release();
    } catch {
      this.#dependencies.logger.warn(
        `github-notifications: ${label} lease release failed agent=${agentId} code=github-notification-${label}-lease-release-failed`,
      );
      return {
        agentId,
        code: `github-notification-${label}-lease-release-failed`,
        status: 'failed',
      };
    }
    return result;
  }

  async #poll(
    agentId: string,
    options: GitHubNotificationMonitorRunOptions,
  ): Promise<GitHubNotificationMonitorRunResult> {
    const { bypassInterval = false, signal } = options;
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
        if (githubNotificationRetirementItemKeys(current).length === 0) {
          await this.#reconciler.retireDisabledAssignments(agentId, current, now, signal);
        }
        return { agentId, code: 'github-notification-disabled', status: 'skipped' };
      }
      if (options.executionSurface !== 'cli-one-shot') {
        const readiness = this.#dependencies.inspectReadiness();
        if (readiness.status === 'blocked') {
          if (current?.diagnosticCode === readiness.code && (current.nextPollAt ?? 0) > now) {
            return {
              agentId,
              code: readiness.code,
              ...monitorStateMetadata(current),
              status: 'failed',
            };
          }
          this.#dependencies.logger.warn(
            `github-notifications: ${readiness.message} ${readiness.remediation}`,
          );
          const failed = await this.#saveFailure(agentId, workspaceDir, now, readiness.code);
          return {
            agentId,
            code: readiness.code,
            ...monitorStateMetadata(failed),
            status: 'failed',
          };
        }
      }
      const pendingItemKeys = pendingGitHubNotificationItemKeys(current, options.selector);
      const intervalDeferred = current?.nextPollAt !== undefined && current.nextPollAt > now;
      const pollDeferred =
        intervalDeferred && (!bypassInterval || (current?.failureCount ?? 0) > 0);
      const routingBackoff =
        pollDeferred &&
        (current?.failureCount ?? 0) > 0 &&
        isPrerequisiteDiagnostic(current?.diagnosticCode);
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
        const failed = await this.#saveFailure(agentId, workspaceDir, now, route.code);
        return {
          agentId,
          code: route.code,
          ...monitorStateMetadata(failed),
          retryAt: failed.nextPollAt,
          status: 'failed',
        };
      }

      if (routingBackoff && current) {
        current = await this.#dependencies.stateStore.update(agentId, (latest) => {
          if (!latest) throw new Error('The GitHub notification monitor state is missing.');
          return { ...latest, diagnosticCode: undefined, failureCount: 0, nextPollAt: now };
        });
      } else if (pollDeferred) {
        return {
          agentId,
          code: 'github-notification-execution-pending',
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
      result.state = await this.#dependencies.stateStore.update(agentId, (latest) =>
        checkpointGitHubNotificationPoll(latest, current, result.state),
      );
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
          const failed = await this.#saveFailure(
            agentId,
            workspaceDir,
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

  async #execute(
    agentId: string,
    options: GitHubNotificationMonitorRunOptions,
    result: GitHubNotificationMonitorRunResult,
    itemKey: string,
  ): Promise<GitHubNotificationMonitorRunResult> {
    const { executionSurface = 'gateway', signal } = options;
    try {
      if (signal?.aborted)
        return { ...result, code: 'github-notification-cycle-aborted', status: 'skipped' };
      // re-read authority and durable work after acquiring this lifecycle's ownership.
      const loaded = await this.#dependencies.manifestService.loadForAgentId(agentId, 'service');
      if (loaded.status !== 'loaded') {
        return {
          ...result,
          code: `github-notification-manifest-${loaded.status}`,
          status: 'skipped',
        };
      }
      const current = await this.#dependencies.stateStore.read(agentId);
      if (current && current.workspaceDir !== loaded.scope.workspaceDir) {
        return {
          ...result,
          code: 'github-notification-execution-context-changed',
          status: 'skipped',
        };
      }
      if (!loaded.manifest.github?.notifications) {
        await this.#reconciler.retireDisabledAssignments(
          agentId,
          current,
          (this.#dependencies.clock ?? Date.now)(),
          signal,
          itemKey,
        );
        return { ...result, code: 'github-notification-disabled', status: 'skipped' };
      }
      if (executionSurface !== 'cli-one-shot') {
        const readiness = this.#dependencies.inspectReadiness();
        if (readiness.status === 'blocked') {
          await this.#reconciler.reconcileAssignments(
            agentId,
            githubNotificationRetirementItemKeys(current).filter((key) => key === itemKey),
            signal,
          );
          return { ...result, code: readiness.code, status: 'failed' };
        }
      }
      const route = await this.#dependencies.routingService.inspect({
        agentId,
        enabled: true,
        workspaceDir: loaded.scope.workspaceDir,
      });
      if (route.kind !== 'noop' || route.code !== 'notification-routing-ready') {
        await this.#reconciler.reconcileAssignments(
          agentId,
          githubNotificationRetirementItemKeys(current).filter((key) => key === itemKey),
          signal,
        );
        return { ...result, code: route.code, status: 'failed' };
      }
      await this.#reconciler.reconcileAssignments(
        agentId,
        pendingGitHubNotificationItemKeys(current, options.selector).filter(
          (key) => key === itemKey,
        ),
        signal,
      );
      const commentFailure = await this.#reconciler.reconcileCommentsSafely(
        agentId,
        itemKey,
        executionSurface,
        signal,
      );
      await this.#reconciler.reconcileAssignmentResponses(
        agentId,
        itemKey,
        executionSurface,
        signal,
      );
      if (signal?.aborted)
        return { ...result, code: 'github-notification-cycle-aborted', status: 'skipped' };
      if (commentFailure) return { ...result, code: commentFailure.code, status: 'failed' };
      return completedExecutionResult(result);
    } catch (error) {
      if (signal?.aborted)
        return { ...result, code: 'github-notification-cycle-aborted', status: 'skipped' };
      const diagnostic = githubNotificationDiagnostic(error);
      this.#dependencies.logger.warn(
        `github-notifications: execution failed agent=${agentId} code=${diagnostic.code}`,
      );
      // execution failures belong to lifecycle checkpoints, not provider polling backoff.
      return { ...result, code: diagnostic.code, status: 'failed' };
    }
  }

  async #saveFailure(
    agentId: string,
    workspaceDir: string,
    now: number,
    code: string,
    retryAt?: number,
  ): Promise<GitHubNotificationMonitorState> {
    return this.#dependencies.stateStore.update(agentId, (current) =>
      createGitHubNotificationFailureState({
        agentId,
        code,
        current,
        now,
        random: this.#dependencies.random ?? Math.random,
        ...(retryAt === undefined ? {} : { retryAt }),
        workspaceDir,
      }),
    );
  }
}
