import type { Logger } from '../../../lib/logger.ts';
import type { GitHubNotificationRecordedSession } from '../utils/delivery-plan.ts';
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

interface PendingAssignment {
  delivery: GitHubNotificationDeliveryState;
  item: GitHubNotificationItemState;
  itemKey: string;
  workspaceDir: string;
}

export interface GitHubNotificationAssignmentDispatchServiceDependencies {
  authority: Pick<GitHubNotificationAssignmentProvider, 'loadPlanningContext'>;
  leaseStore: Pick<GitHubNotificationMonitorCycleLeaseStore, 'acquire'>;
  logger: Logger;
  sessions: Pick<GitHubNotificationSessionService, 'planAssignment'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
}

export type GitHubNotificationAssignmentDispatchScheduleStatus = 'already-scheduled' | 'scheduled';

class GitHubNotificationAssignmentDispatchServiceError extends Error {
  override name = 'GitHubNotificationAssignmentDispatchServiceError';

  constructor(readonly code: string) {
    super('The GitHub notification assignment turn could not proceed.');
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
  return 'github-notification-assignment-dispatch-failed';
}

function pendingAssignment(
  state: GitHubNotificationMonitorState | undefined,
): PendingAssignment | undefined {
  if (!state) return undefined;
  for (const [itemKey, item] of Object.entries(state.items).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const delivery = item.delivery;
    const legacyPendingActivation =
      delivery?.stage === 'active' && delivery.activation?.status === 'pending';
    if (
      item.disposition !== 'approved' ||
      !delivery ||
      delivery.stage === 'retired' ||
      (delivery.stage === 'active' && !legacyPendingActivation) ||
      (delivery.activation !== undefined && delivery.activation.status !== 'pending')
    ) {
      continue;
    }
    const localContextReady =
      item.itemType === 'pull-request' ||
      (delivery.worktreeBranch !== undefined && delivery.worktreePath !== undefined);
    if (localContextReady) return { delivery, item, itemKey, workspaceDir: state.workspaceDir };
  }
  return undefined;
}

function withoutFailure(
  delivery: GitHubNotificationDeliveryState,
): GitHubNotificationDeliveryState {
  const next = { ...delivery };
  Reflect.deleteProperty(next, 'failureCode');
  return next;
}

/** Dispatch each ready assignment as one normal OpenClaw inbound turn. */
export default class GitHubNotificationAssignmentDispatchService {
  readonly #dependencies: GitHubNotificationAssignmentDispatchServiceDependencies;
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(dependencies: GitHubNotificationAssignmentDispatchServiceDependencies) {
    this.#dependencies = dependencies;
  }

  schedule(
    agentId: string,
    signal: AbortSignal,
  ): GitHubNotificationAssignmentDispatchScheduleStatus {
    if (this.#inFlight.has(agentId)) return 'already-scheduled';
    const task = this.#drain(agentId, signal)
      .catch((error: unknown) => {
        if (!signal.aborted) {
          this.#dependencies.logger.warn(
            `github-notifications: assignment dispatch failed agent=${agentId} code=${errorCode(error)}`,
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
      const pending = pendingAssignment(await this.#dependencies.stateStore.read(agentId));
      if (!pending) return;
      await this.#dispatch(agentId, pending, signal);
    }
  }

  async #dispatch(agentId: string, pending: PendingAssignment, signal: AbortSignal): Promise<void> {
    let adopted = false;
    let planningCompleted = false;
    try {
      const planning = await this.#dependencies.authority.loadPlanningContext({
        agentId,
        delivery: pending.delivery,
        item: pending.item,
        signal,
        workspaceDir: pending.workspaceDir,
      });
      if (!planning.authorized) {
        await this.#checkpoint(agentId, pending.itemKey, signal, (delivery) => ({
          ...delivery,
          activation: { failureCode: planning.reasonCode, status: 'pending' },
        }));
        throw new GitHubNotificationAssignmentDispatchServiceError(planning.reasonCode);
      }
      const result = await this.#dependencies.sessions.planAssignment({
        agentId,
        context: planning.context,
        delivery: pending.delivery,
        item: pending.item,
        onAcknowledgmentCompleted: (acknowledgment) =>
          this.#checkpoint(agentId, pending.itemKey, signal, (delivery) => ({
            ...delivery,
            acknowledgment,
          })),
        onPlanningCompleted: async () => {
          await this.#checkpoint(agentId, pending.itemKey, signal, (delivery) => ({
            ...delivery,
            activation: { reply: { status: 'pending' }, status: 'planned' },
          }));
          planningCompleted = true;
          this.#dependencies.logger.info(
            `github-notifications: private planning complete agent=${agentId} reply=pending`,
          );
        },
        onTurnAdopted: async (session) => {
          adopted = true;
          await this.#checkpoint(agentId, pending.itemKey, signal, (delivery) =>
            this.#adoptedDelivery(delivery, session),
          );
          this.#dependencies.logger.info(
            `github-notifications: assignment turn adopted agent=${agentId}`,
          );
        },
        signal,
        workspaceDir: pending.workspaceDir,
        ...(pending.delivery.worktreeBranch === undefined ||
        pending.delivery.worktreePath === undefined
          ? {}
          : {
              worktree: {
                branch: pending.delivery.worktreeBranch,
                path: pending.delivery.worktreePath,
              },
            }),
      });
      await this.#checkpoint(agentId, pending.itemKey, signal, (delivery) => ({
        ...delivery,
        activation: { reply: result.reply, status: 'planned' },
      }));
      this.#dependencies.logger.info(
        result.reply.status === 'published'
          ? `github-notifications: planning complete agent=${agentId} reply=published code=github-notification-planning-complete`
          : `github-notifications: planning complete agent=${agentId} reply=failed code=${result.reply.failureCode}`,
      );
    } catch (error) {
      if (signal.aborted) return;
      const code = errorCode(error);
      if (planningCompleted) {
        this.#dependencies.logger.warn(
          `github-notifications: planning reply checkpoint deferred agent=${agentId} code=${code}`,
        );
        return;
      }
      const status = adopted ? 'failed' : 'pending';
      await this.#checkpoint(agentId, pending.itemKey, signal, (delivery) => ({
        ...delivery,
        activation: { failureCode: code, status },
      })).catch(() => undefined);
      this.#dependencies.logger.warn(
        `github-notifications: assignment dispatch ${status === 'failed' ? 'failed' : 'deferred'} agent=${agentId} code=${code} adopted=${adopted}`,
      );
      throw error;
    }
  }

  #adoptedDelivery(
    delivery: GitHubNotificationDeliveryState,
    session: GitHubNotificationRecordedSession,
  ): GitHubNotificationDeliveryState {
    return {
      ...withoutFailure(delivery),
      activation: { status: 'adopted' },
      mode: session.mode ?? delivery.mode ?? 'plan',
      sessionId: session.id,
      sessionKey: session.key,
      stage: 'active',
    };
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
      throw new Error(`GitHub notification assignment checkpoint ${acquisition.status}.`);
    }
    try {
      const current = await this.#dependencies.stateStore.read(agentId);
      const item = current?.items[itemKey];
      if (!current || !item?.delivery || item.disposition !== 'approved') return;
      const state = structuredClone(current);
      state.items[itemKey] = { ...item, delivery: update(item.delivery) };
      await this.#dependencies.stateStore.write(state);
    } finally {
      await acquisition.lease.release();
    }
  }
}
