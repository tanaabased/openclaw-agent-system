import { listAgentIds } from 'openclaw/plugin-sdk/agent-runtime';
import { sleepWithAbort } from 'openclaw/plugin-sdk/infra-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentManifestService from '../../../../manifest/service.ts';
import {
  GitHubAccountClientError,
  type default as GitHubAccountClient,
} from '../../../../core/github-account-client.ts';
import type { Logger } from '../../../../core/logger.ts';
import {
  createGitHubNotificationMonitorState,
  githubNotificationRetirementItemKeys,
  type GitHubNotificationMonitorState,
} from './state.ts';
import {
  githubNotificationItemMatchesSelector,
  type GitHubNotificationItemSelector,
} from '../../provider/work-item.ts';
import type { GitHubNotificationExecutionSurface } from '../../conversation/execution.ts';
import type { GitHubNotificationCommentReconcileOptions } from '../../conversation/comment-orchestrator.ts';
import type { GitHubNotificationAssignmentResponseReconcileOptions } from '../../conversation/assignment-response-orchestrator.ts';
import type GitHubNotificationMonitorCycleLeaseStore from './cycle-lease.ts';
import type GitHubNotificationMonitorStateStore from './state-store.ts';
import { GitHubNotificationPollError, pollGitHubNotifications } from './poller.ts';
import type NotificationRoutingService from '../../routing/service.ts';
import GitHubWorkEventClient from '../../provider/work-event-client.ts';

const schedulerIntervalMs = 30_000;
const maximumFailureBackoffMs = 60 * 60 * 1000;

export interface GitHubNotificationMonitorServiceDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  assignmentOrchestrator: {
    reconcile(agentId: string, itemKey: string, signal?: AbortSignal): Promise<void>;
  };
  assignmentResponseOrchestrator?: {
    reconcile(
      agentId: string,
      itemKey: string,
      options?: GitHubNotificationAssignmentResponseReconcileOptions,
    ): Promise<void>;
  };
  commentOrchestrator?: {
    reconcile(
      agentId: string,
      itemKey: string,
      options?: GitHubNotificationCommentReconcileOptions,
    ): Promise<void>;
  };
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

function diagnosticCode(error: unknown): { code: string; retryAt?: number } {
  if (error instanceof GitHubNotificationPollError) {
    return { code: error.code, ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }) };
  }
  if (error instanceof GitHubAccountClientError) return { code: error.code };
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('github-notification-')
  ) {
    return { code: error.code };
  }
  return { code: 'github-notification-monitor-failed' };
}

function matchesSelector(
  item: GitHubNotificationMonitorState['items'][string],
  selector: GitHubNotificationItemSelector,
): boolean {
  return githubNotificationItemMatchesSelector(
    item,
    `${item.repositoryOwner}/${item.repositoryName}`,
    selector,
  );
}

function pendingIntakeItemKeys(
  state: GitHubNotificationMonitorState | undefined,
  selector?: GitHubNotificationItemSelector,
): string[] {
  if (!state) return [];
  return Object.entries(state.items)
    .filter(
      ([, item]) =>
        (selector === undefined || matchesSelector(item, selector)) &&
        item.intake !== undefined &&
        ((item.disposition === 'approved' && item.intake.stage === 'admitted') ||
          (item.disposition === 'retired' && item.intake.stage !== 'retired')),
    )
    .map(([itemKey]) => itemKey)
    .sort();
}

function preparedIssueItemKeys(
  state: GitHubNotificationMonitorState | undefined,
  selector?: GitHubNotificationItemSelector,
): string[] {
  if (!state) return [];
  return Object.entries(state.items)
    .filter(
      ([, item]) =>
        (selector === undefined || matchesSelector(item, selector)) &&
        item.disposition === 'approved' &&
        item.lifecycleId === 'issue' &&
        item.intake?.stage === 'prepared',
    )
    .map(([itemKey]) => itemKey)
    .sort();
}

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

  constructor(dependencies: GitHubNotificationMonitorServiceDependencies) {
    this.#dependencies = dependencies;
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
        await this.#retireDisabledAssignments(agentId, current, now, signal);
        return { agentId, code: 'github-notification-disabled', status: 'skipped' };
      }
      const pendingItemKeys = pendingIntakeItemKeys(current, options.selector);
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
        await this.#reconcileAssignments(
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
        await this.#reconcileAssignments(agentId, pendingItemKeys, signal);
        await this.#reconcileAssignmentResponses(
          agentId,
          options.selector,
          executionSurface,
          signal,
        );
        await this.#reconcileComments(agentId, options.selector, executionSurface, signal);
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
      await this.#reconcileAssignments(
        agentId,
        pendingIntakeItemKeys(result.state, options.selector),
        signal,
      );
      try {
        await this.#reconcileAssignmentResponses(
          agentId,
          options.selector,
          executionSurface,
          signal,
        );
        await this.#reconcileComments(agentId, options.selector, executionSurface, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        const diagnostic = diagnosticCode(error);
        this.#dependencies.logger.warn(
          `github-notifications: conversation reconciliation failed agent=${agentId} code=${diagnostic.code}`,
        );
        return {
          agentId,
          approved: result.approved,
          baseline: result.baseline,
          baselineAt: result.state.baselineAt,
          baselineEstablished: result.baselineEstablished,
          code: diagnostic.code,
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
      const diagnostic = diagnosticCode(error);
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

  async #reconcileAssignments(
    agentId: string,
    itemKeys: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const itemKey of itemKeys) {
      if (signal?.aborted) return;
      await this.#dependencies.assignmentOrchestrator.reconcile(agentId, itemKey, signal);
    }
  }

  async #reconcileComments(
    agentId: string,
    selector: GitHubNotificationItemSelector | undefined,
    executionSurface: GitHubNotificationExecutionSurface,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#dependencies.commentOrchestrator) return;
    const state = await this.#dependencies.stateStore.read(agentId);
    for (const itemKey of preparedIssueItemKeys(state, selector)) {
      if (signal?.aborted) return;
      await this.#dependencies.commentOrchestrator.reconcile(agentId, itemKey, {
        executionSurface,
        ...(signal === undefined ? {} : { signal }),
      });
    }
  }

  async #reconcileAssignmentResponses(
    agentId: string,
    selector: GitHubNotificationItemSelector | undefined,
    executionSurface: GitHubNotificationExecutionSurface,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#dependencies.assignmentResponseOrchestrator) return;
    const state = await this.#dependencies.stateStore.read(agentId);
    for (const itemKey of preparedIssueItemKeys(state, selector)) {
      if (signal?.aborted) return;
      await this.#dependencies.assignmentResponseOrchestrator.reconcile(agentId, itemKey, {
        executionSurface,
        ...(signal === undefined ? {} : { signal }),
      });
    }
  }

  async #retireDisabledAssignments(
    agentId: string,
    current: GitHubNotificationMonitorState | undefined,
    now: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const itemKeys = githubNotificationRetirementItemKeys(current);
    if (itemKeys.length === 0) {
      await this.#dependencies.stateStore.remove?.(agentId);
      return;
    }
    const retryDeferred =
      current?.nextPollAt !== undefined &&
      current.nextPollAt > now &&
      itemKeys.some((itemKey) => current.items[itemKey]?.intake?.failureCode !== undefined);
    if (retryDeferred) return;

    await this.#reconcileAssignments(agentId, itemKeys, signal);
    const reconciled = await this.#dependencies.stateStore.read(agentId);
    if (githubNotificationRetirementItemKeys(reconciled).length === 0) {
      await this.#dependencies.stateStore.remove?.(agentId);
    }
  }

  async #saveFailure(
    agentId: string,
    workspaceDir: string,
    current: GitHubNotificationMonitorState | undefined,
    now: number,
    code: string,
    retryAt = 0,
  ): Promise<GitHubNotificationMonitorState> {
    const state = current ?? createGitHubNotificationMonitorState(agentId, workspaceDir);
    state.diagnosticCode = code;
    state.failureCount += 1;
    state.lastPollAt = now;
    const exponential = Math.min(
      maximumFailureBackoffMs,
      30_000 * 2 ** Math.min(state.failureCount - 1, 7),
    );
    const jitter = 0.9 + (this.#dependencies.random ?? Math.random)() * 0.2;
    state.nextPollAt = Math.max(now + Math.floor(exponential * jitter), retryAt);
    await this.#dependencies.stateStore.write(state);
    return state;
  }
}
