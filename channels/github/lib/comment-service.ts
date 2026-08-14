import type { Logger } from '../../../lib/logger.ts';
import type {
  GitHubNotificationCommentRevisionState,
  GitHubNotificationDeliveryState,
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../utils/monitor-state.ts';
import type GitHubNotificationAssignmentProvider from './assignment-provider.ts';
import type GitHubNotificationMonitorCycleLeaseStore from './monitor-cycle-lease.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';
import type GitHubNotificationSessionService from './session-service.ts';

const cycleLeaseWaitMs = 30_000;

interface PendingComment {
  comment: GitHubNotificationCommentRevisionState & {
    disposition: 'approved';
    turn: { failureCode?: string; status: 'pending' };
  };
  delivery: GitHubNotificationDeliveryState & {
    sessionKey: string;
    stage: 'active';
    worktreeBranch: string;
    worktreePath: string;
  };
  item: GitHubNotificationItemState;
  itemKey: string;
  workspaceDir: string;
}

export interface GitHubNotificationCommentServiceDependencies {
  authority: Pick<GitHubNotificationAssignmentProvider, 'loadCommentContext'>;
  leaseStore: Pick<GitHubNotificationMonitorCycleLeaseStore, 'acquire'>;
  logger: Logger;
  sessions: Pick<GitHubNotificationSessionService, 'respondToComment'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
}

export type GitHubNotificationCommentScheduleStatus = 'already-scheduled' | 'scheduled';

class GitHubNotificationCommentServiceError extends Error {
  override name = 'GitHubNotificationCommentServiceError';

  constructor(readonly code: string) {
    super('The GitHub notification comment response could not proceed.');
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
  return 'github-notification-comment-dispatch-failed';
}

function pendingComment(
  state: GitHubNotificationMonitorState | undefined,
): PendingComment | undefined {
  if (!state) return undefined;
  for (const [itemKey, item] of Object.entries(state.items).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const delivery = item.delivery;
    if (
      item.disposition !== 'approved' ||
      delivery?.stage !== 'active' ||
      !delivery.sessionKey ||
      !delivery.worktreeBranch ||
      !delivery.worktreePath
    ) {
      continue;
    }
    for (const comment of Object.values(item.commentTracking?.revisions ?? {}).sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.commentDatabaseId - right.commentDatabaseId,
    )) {
      if (comment.disposition === 'approved' && comment.turn?.status === 'pending') {
        return {
          comment: comment as PendingComment['comment'],
          delivery: delivery as PendingComment['delivery'],
          item,
          itemKey,
          workspaceDir: state.workspaceDir,
        };
      }
    }
  }
  return undefined;
}

/** Run admitted GitHub comment turns only inside the long-lived Gateway lifecycle. */
export default class GitHubNotificationCommentService {
  readonly #dependencies: GitHubNotificationCommentServiceDependencies;
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(dependencies: GitHubNotificationCommentServiceDependencies) {
    this.#dependencies = dependencies;
  }

  schedule(agentId: string, signal: AbortSignal): GitHubNotificationCommentScheduleStatus {
    if (this.#inFlight.has(agentId)) return 'already-scheduled';
    const task = this.#drain(agentId, signal)
      .catch((error: unknown) => {
        if (!signal.aborted) {
          this.#dependencies.logger.warn(
            `github-notifications: comment drain failed agent=${agentId} code=${errorCode(error)}`,
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
      const pending = pendingComment(await this.#dependencies.stateStore.read(agentId));
      if (!pending) return;
      await this.#respond(agentId, pending, signal);
    }
  }

  async #respond(agentId: string, pending: PendingComment, signal: AbortSignal): Promise<void> {
    let adopted = false;
    try {
      const authorized = await this.#dependencies.authority.loadCommentContext({
        agentId,
        comment: pending.comment,
        delivery: pending.delivery,
        item: pending.item,
        signal,
        workspaceDir: pending.workspaceDir,
      });
      if (!authorized.authorized) {
        if (
          authorized.reasonCode === 'github-notification-route-revoked' ||
          authorized.reasonCode === 'github-notification-configuration-revoked'
        ) {
          throw new GitHubNotificationCommentServiceError(authorized.reasonCode);
        }
        await this.#checkpoint(agentId, pending, signal, (comment) => ({
          ...comment,
          disposition: 'rejected',
          reasonCode: authorized.reasonCode,
          reply: undefined,
          turn: undefined,
        }));
        this.#dependencies.logger.info(
          `github-notifications: comment rejected agent=${agentId} code=${authorized.reasonCode}`,
        );
        return;
      }
      const result = await this.#dependencies.sessions.respondToComment({
        agentId,
        comment: pending.comment,
        context: authorized.context,
        delivery: pending.delivery,
        item: pending.item,
        onTurnAdopted: async () => {
          adopted = true;
          await this.#checkpoint(agentId, pending, signal, (comment) => ({
            ...comment,
            turn: { status: 'adopted' },
          }));
          this.#dependencies.logger.info(
            `github-notifications: comment turn adopted agent=${agentId} reply=pending`,
          );
        },
        signal,
        workspaceDir: pending.workspaceDir,
        worktree: {
          branch: pending.delivery.worktreeBranch,
          path: pending.delivery.worktreePath,
        },
      });
      await this.#checkpoint(agentId, pending, signal, (comment) => ({
        ...comment,
        reply: result.reply,
        turn: { status: 'responded' },
      }));
      this.#dependencies.logger[result.reply.status === 'failed' ? 'warn' : 'info'](
        result.reply.status === 'failed'
          ? `github-notifications: comment response complete agent=${agentId} reply=failed code=${result.reply.failureCode}`
          : `github-notifications: comment response complete agent=${agentId} reply=published code=github-notification-comment-response-complete`,
      );
    } catch (error) {
      if (signal.aborted) return;
      const code = errorCode(error);
      await this.#checkpoint(agentId, pending, signal, (comment) => ({
        ...comment,
        turn: { failureCode: code, status: adopted ? 'failed' : 'pending' },
      })).catch(() => undefined);
      this.#dependencies.logger.warn(
        `github-notifications: comment ${adopted ? 'failed' : 'deferred'} agent=${agentId} code=${code} adopted=${adopted}`,
      );
      throw error;
    }
  }

  async #checkpoint(
    agentId: string,
    pending: PendingComment,
    signal: AbortSignal,
    update: (
      comment: GitHubNotificationCommentRevisionState,
    ) => GitHubNotificationCommentRevisionState,
  ): Promise<void> {
    const acquisition = await this.#dependencies.leaseStore.acquire(agentId, {
      signal,
      waitMs: cycleLeaseWaitMs,
    });
    if (acquisition.status !== 'acquired') {
      throw new Error(`GitHub notification comment checkpoint ${acquisition.status}.`);
    }
    try {
      const current = await this.#dependencies.stateStore.read(agentId);
      const item = current?.items[pending.itemKey];
      const comment = item?.commentTracking?.revisions[pending.comment.commentNodeId];
      if (
        !current ||
        !item?.commentTracking ||
        !comment ||
        comment.revisionId !== pending.comment.revisionId
      ) {
        return;
      }
      const state = structuredClone(current);
      const tracking = state.items[pending.itemKey]!.commentTracking!;
      tracking.revisions[pending.comment.commentNodeId] = update(comment);
      await this.#dependencies.stateStore.write(state);
    } finally {
      await acquisition.lease.release();
    }
  }
}
