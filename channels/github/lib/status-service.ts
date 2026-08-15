import type GitHubNotificationMonitorService from './monitor-service.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';
import {
  evaluateGitHubNotificationWait,
  githubNotificationMonitorStatus,
  type GitHubNotificationItemSelector,
  type GitHubNotificationStatusResult,
  type GitHubNotificationWaitTarget,
} from '../utils/monitor-status.ts';

const defaultPollIntervalMs = 1_000;
const maximumRefreshLeaseWaitMs = 30_000;

export interface GitHubNotificationStatusServiceDependencies {
  clock?: () => number;
  monitorService: Pick<GitHubNotificationMonitorService, 'runOnce'>;
  sleep?: (milliseconds: number) => Promise<void>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read'>;
}

export interface GitHubNotificationWaitInput {
  agentId: string;
  commentId?: number;
  refresh: boolean;
  selector?: GitHubNotificationItemSelector;
  target: GitHubNotificationWaitTarget;
  timeoutMs: number;
}

export interface GitHubNotificationWaitResult {
  agentId: string;
  code: string;
  observation: GitHubNotificationStatusResult;
  schemaVersion: 1;
  status: 'completed' | 'failed' | 'timed-out';
  target: GitHubNotificationWaitTarget;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Read and wait on durable notification checkpoints without inspecting chat prose. */
export default class GitHubNotificationStatusService {
  readonly #clock: () => number;
  readonly #monitorService: Pick<GitHubNotificationMonitorService, 'runOnce'>;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #stateStore: Pick<GitHubNotificationMonitorStateStore, 'read'>;

  constructor(dependencies: GitHubNotificationStatusServiceDependencies) {
    this.#clock = dependencies.clock ?? Date.now;
    this.#monitorService = dependencies.monitorService;
    this.#sleep = dependencies.sleep ?? defaultSleep;
    this.#stateStore = dependencies.stateStore;
  }

  async inspect(
    agentId: string,
    selector?: GitHubNotificationItemSelector,
  ): Promise<GitHubNotificationStatusResult> {
    return githubNotificationMonitorStatus(agentId, await this.#stateStore.read(agentId), selector);
  }

  async wait(input: GitHubNotificationWaitInput): Promise<GitHubNotificationWaitResult> {
    const deadline = this.#clock() + input.timeoutMs;
    while (true) {
      if (this.#clock() >= deadline) {
        return {
          agentId: input.agentId,
          code: 'github-notification-wait-timeout',
          observation: await this.inspect(input.agentId, input.selector),
          schemaVersion: 1,
          status: 'timed-out',
          target: input.target,
        };
      }
      if (input.refresh) {
        const remainingMs = Math.max(1, deadline - this.#clock());
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), remainingMs);
        let refresh;
        try {
          [refresh] = await this.#monitorService.runOnce({
            agentId: input.agentId,
            bypassInterval: true,
            signal: controller.signal,
            waitForLeaseMs: Math.min(remainingMs, maximumRefreshLeaseWaitMs),
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!refresh || refresh.status !== 'completed') {
          return {
            agentId: input.agentId,
            code: refresh?.code ?? 'github-notification-refresh-missing',
            observation: await this.inspect(input.agentId, input.selector),
            schemaVersion: 1,
            status: 'failed',
            target: input.target,
          };
        }
      }

      const observation = await this.inspect(input.agentId, input.selector);
      const evaluated = evaluateGitHubNotificationWait(
        observation,
        input.target,
        input.selector,
        input.commentId,
      );
      if (evaluated.status !== 'pending') {
        return {
          agentId: input.agentId,
          code: evaluated.code,
          observation,
          schemaVersion: 1,
          status: evaluated.status === 'reached' ? 'completed' : 'failed',
          target: input.target,
        };
      }
      const remainingMs = deadline - this.#clock();
      if (remainingMs <= 0) {
        return {
          agentId: input.agentId,
          code: 'github-notification-wait-timeout',
          observation,
          schemaVersion: 1,
          status: 'timed-out',
          target: input.target,
        };
      }
      await this.#sleep(Math.min(defaultPollIntervalMs, remainingMs));
    }
  }
}
