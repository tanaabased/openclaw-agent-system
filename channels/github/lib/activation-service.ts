import type { Logger } from '../../../lib/logger.ts';
import type {
  GitHubNotificationDeliveryState,
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../utils/monitor-state.ts';
import type GitHubNotificationAssignmentProvider from './assignment-provider.ts';
import type GitHubNotificationMonitorCycleLeaseStore from './monitor-cycle-lease.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';
import type GitHubNotificationSessionService from './session-service.ts';

const cycleLeaseWaitMs = 30_000;

interface PendingActivation {
  delivery: GitHubNotificationDeliveryState & {
    activation: { failureCode?: string; status: 'pending' };
    sessionKey: string;
    worktreeBranch: string;
    worktreePath: string;
  };
  item: GitHubNotificationItemState;
  itemKey: string;
  workspaceDir: string;
}

export interface GitHubNotificationActivationServiceDependencies {
  authority: Pick<GitHubNotificationAssignmentProvider, 'loadPlanningContext'>;
  leaseStore: Pick<GitHubNotificationMonitorCycleLeaseStore, 'acquire'>;
  logger: Logger;
  sessions: Pick<GitHubNotificationSessionService, 'planAssignment'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
}

export type GitHubNotificationActivationScheduleStatus = 'already-scheduled' | 'scheduled';

class GitHubNotificationActivationServiceError extends Error {
  override name = 'GitHubNotificationActivationServiceError';

  constructor(readonly code: string) {
    super('The GitHub notification activation could not proceed.');
  }
}

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('github-notification-')
  ) {
    return error.code;
  }
  return 'github-notification-activation-failed';
}

function pendingActivation(
  state: GitHubNotificationMonitorState | undefined,
): PendingActivation | undefined {
  if (!state) return undefined;
  for (const [itemKey, item] of Object.entries(state.items).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const delivery = item.delivery;
    if (
      item.disposition === 'approved' &&
      delivery?.stage === 'active' &&
      delivery.activation?.status === 'pending' &&
      delivery.sessionKey &&
      delivery.worktreeBranch &&
      delivery.worktreePath
    ) {
      return {
        delivery: delivery as PendingActivation['delivery'],
        item,
        itemKey,
        workspaceDir: state.workspaceDir,
      };
    }
  }
  return undefined;
}

/** Run new assignment planning turns only inside the long-lived Gateway lifecycle. */
export default class GitHubNotificationActivationService {
  readonly #dependencies: GitHubNotificationActivationServiceDependencies;
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(dependencies: GitHubNotificationActivationServiceDependencies) {
    this.#dependencies = dependencies;
  }

  schedule(agentId: string, signal: AbortSignal): GitHubNotificationActivationScheduleStatus {
    if (this.#inFlight.has(agentId)) return 'already-scheduled';
    const task = this.#drain(agentId, signal)
      .catch((error: unknown) => {
        if (!signal.aborted) {
          this.#dependencies.logger.warn(
            `github-notifications: activation drain failed agent=${agentId} code=${errorCode(error)}`,
          );
        }
      })
      .finally(() => {
        if (this.#inFlight.get(agentId) === task) this.#inFlight.delete(agentId);
      });
    this.#inFlight.set(agentId, task);
    return 'scheduled';
  }

  async settle(agentId: string): Promise<void> {
    const task = this.#inFlight.get(agentId);
    if (task) await task;
  }

  async #drain(agentId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const pending = pendingActivation(await this.#dependencies.stateStore.read(agentId));
      if (!pending) return;
      await this.#activate(agentId, pending, signal);
    }
  }

  async #activate(agentId: string, pending: PendingActivation, signal: AbortSignal): Promise<void> {
    let adopted = false;
    try {
      const planning = await this.#dependencies.authority.loadPlanningContext({
        agentId,
        delivery: pending.delivery,
        item: pending.item,
        signal,
        workspaceDir: pending.workspaceDir,
      });
      if (!planning.authorized) {
        const ineligible =
          planning.reasonCode === 'github-notification-activation-pull-request-deferred';
        await this.#checkpoint(agentId, pending.itemKey, signal, (delivery) => ({
          ...delivery,
          activation: {
            failureCode: planning.reasonCode,
            status: ineligible ? 'ineligible' : 'pending',
          },
        }));
        if (ineligible) return;
        throw new GitHubNotificationActivationServiceError(planning.reasonCode);
      }
      const result = await this.#dependencies.sessions.planAssignment({
        agentId,
        context: planning.context,
        delivery: pending.delivery,
        item: pending.item,
        onTurnAdopted: async () => {
          adopted = true;
          await this.#checkpoint(agentId, pending.itemKey, signal, (delivery) => ({
            ...delivery,
            activation: { status: 'adopted' },
          }));
        },
        signal,
        workspaceDir: pending.workspaceDir,
        worktree: {
          branch: pending.delivery.worktreeBranch,
          path: pending.delivery.worktreePath,
        },
      });
      await this.#checkpoint(agentId, pending.itemKey, signal, (delivery) => ({
        ...delivery,
        acknowledgment:
          result.acknowledgmentCommentId === undefined
            ? { status: 'pending' }
            : { commentId: result.acknowledgmentCommentId, status: 'published' },
        activation: {
          ...(result.acknowledgmentFailureCode === undefined
            ? {}
            : { failureCode: result.acknowledgmentFailureCode }),
          status: 'planned',
        },
      }));
      this.#dependencies.logger.info(
        `github-notifications: activation complete agent=${agentId} code=github-notification-planning-complete`,
      );
    } catch (error) {
      if (signal.aborted) return;
      const code = errorCode(error);
      const status = adopted ? 'failed' : 'pending';
      await this.#checkpoint(agentId, pending.itemKey, signal, (delivery) => ({
        ...delivery,
        activation: { failureCode: code, status },
      })).catch(() => undefined);
      this.#dependencies.logger.warn(
        `github-notifications: activation ${status === 'failed' ? 'failed' : 'deferred'} agent=${agentId} code=${code} adopted=${adopted}`,
      );
      throw error;
    }
  }

  async #checkpoint(
    agentId: string,
    itemKey: string,
    signal: AbortSignal,
    update: (delivery: GitHubNotificationDeliveryState) => GitHubNotificationDeliveryState,
  ): Promise<void> {
    const acquisition = await this.#dependencies.leaseStore.acquire(agentId, {
      signal,
      waitMs: cycleLeaseWaitMs,
    });
    if (acquisition.status !== 'acquired') {
      throw new Error(`GitHub notification activation checkpoint ${acquisition.status}.`);
    }
    try {
      const current = await this.#dependencies.stateStore.read(agentId);
      const item = current?.items[itemKey];
      if (!current || !item?.delivery || item.delivery.stage !== 'active') return;
      const state = structuredClone(current);
      state.items[itemKey] = { ...item, delivery: update(item.delivery) };
      await this.#dependencies.stateStore.write(state);
    } finally {
      await acquisition.lease.release();
    }
  }
}
