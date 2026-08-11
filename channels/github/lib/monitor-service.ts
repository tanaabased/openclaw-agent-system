import { listAgentIds } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig, OpenClawPluginService } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import {
  GitHubAccountClientError,
  type default as GitHubAccountClient,
} from '../../../lib/github-account-client.ts';
import type { Logger } from '../../../lib/logger.ts';
import {
  createGitHubNotificationMonitorState,
  type GitHubNotificationMonitorState,
} from '../utils/monitor-state.ts';
import type NotificationRoutingService from './routing-service.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';
import { GitHubNotificationPollError, pollGitHubNotifications } from './poller.ts';
import GitHubWorkEventClient from './work-event-client.ts';

const schedulerIntervalMs = 30_000;
const maximumFailureBackoffMs = 60 * 60 * 1000;

export interface GitHubNotificationMonitorServiceDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  clock?: () => number;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  random?: () => number;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  routingService: Pick<NotificationRoutingService, 'inspect'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function diagnosticCode(error: unknown): { code: string; retryAt?: number } {
  if (error instanceof GitHubNotificationPollError) {
    return { code: error.code, ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }) };
  }
  if (error instanceof GitHubAccountClientError) return { code: error.code };
  return { code: 'github-notification-monitor-failed' };
}

/** Schedule route-gated, observe-only GitHub assignment polls for configured agents. */
export default class GitHubNotificationMonitorService {
  readonly #dependencies: GitHubNotificationMonitorServiceDependencies;
  readonly #inFlight = new Set<string>();
  #controller?: AbortController;
  #loop?: Promise<void>;

  constructor(dependencies: GitHubNotificationMonitorServiceDependencies) {
    this.#dependencies = dependencies;
  }

  pluginService(): OpenClawPluginService {
    return {
      id: 'agent-system-github-notifications',
      start: () => this.start(),
      stop: () => this.stop(),
    };
  }

  start(): void {
    if (this.#controller) return;
    this.#controller = new AbortController();
    this.#loop = this.#runLoop(this.#controller.signal);
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    await this.#loop;
    this.#controller = undefined;
    this.#loop = undefined;
  }

  async runOnce(signal?: AbortSignal): Promise<void> {
    const config = await this.#dependencies.readConfig();
    for (const agentId of listAgentIds(config)) {
      if (signal?.aborted) return;
      await this.#runAgent(agentId, signal);
    }
  }

  async #runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce(signal);
      } catch {
        this.#dependencies.logger.error(
          'github-notifications: monitor cycle failed code=github-notification-monitor-cycle-failed',
        );
      }
      await delay(schedulerIntervalMs, signal);
    }
  }

  async #runAgent(agentId: string, signal?: AbortSignal): Promise<void> {
    if (this.#inFlight.has(agentId)) return;
    this.#inFlight.add(agentId);
    let workspaceDir: string | undefined;
    try {
      const loaded = await this.#dependencies.manifestService.loadForAgentId(agentId, 'service');
      if (loaded.status !== 'loaded' || !loaded.manifest.github?.notifications) return;
      workspaceDir = loaded.scope.workspaceDir;
      const now = (this.#dependencies.clock ?? Date.now)();
      const current = await this.#dependencies.stateStore.read(agentId);
      if (current?.nextPollAt !== undefined && current.nextPollAt > now) return;

      const route = await this.#dependencies.routingService.inspect({
        agentId,
        enabled: true,
        workspaceDir,
      });
      if (route.kind !== 'noop' || route.code !== 'notification-routing-ready') {
        await this.#saveFailure(agentId, workspaceDir, current, now, route.code);
        return;
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
        configuration: loaded.manifest.github.notifications,
        now,
        ...(current === undefined ? {} : { state: current }),
        workspaceDir,
      });
      const intervalMs = loaded.manifest.github.notifications.intervalMinutes * 60 * 1000;
      const jitter = 0.9 + (this.#dependencies.random ?? Math.random)() * 0.2;
      const rateReset = client.rateLimit.remaining === 0 ? (client.rateLimit.resetAt ?? 0) : 0;
      result.state.diagnosticCode = undefined;
      result.state.failureCount = 0;
      result.state.lastPollAt = now;
      result.state.lastSuccessfulPollAt = now;
      result.state.nextPollAt = Math.max(now + Math.floor(intervalMs * jitter), rateReset + 1_000);
      await this.#dependencies.stateStore.write(result.state);
      this.#dependencies.logger.info(
        `github-notifications: poll complete agent=${agentId} code=github-notification-poll-complete baseline=${result.baseline} approved=${result.approved} rejected=${result.rejected} duplicate=${result.duplicates} retired=${result.retired}`,
      );
    } catch (error) {
      const now = (this.#dependencies.clock ?? Date.now)();
      const diagnostic = diagnosticCode(error);
      try {
        if (workspaceDir) {
          const current = await this.#dependencies.stateStore.read(agentId);
          await this.#saveFailure(
            agentId,
            workspaceDir,
            current,
            now,
            diagnostic.code,
            diagnostic.retryAt,
          );
        }
      } catch {
        this.#dependencies.logger.error(
          `github-notifications: monitor state unsafe agent=${agentId} code=github-notification-state-unsafe`,
        );
        return;
      }
      this.#dependencies.logger.warn(
        `github-notifications: poll deferred agent=${agentId} code=${diagnostic.code}`,
      );
    } finally {
      this.#inFlight.delete(agentId);
    }
  }

  async #saveFailure(
    agentId: string,
    workspaceDir: string,
    current: GitHubNotificationMonitorState | undefined,
    now: number,
    code: string,
    retryAt = 0,
  ): Promise<void> {
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
  }
}
