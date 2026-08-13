import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import type GitHubAccountClient from '../../../lib/github-account-client.ts';
import type { Logger } from '../../../lib/logger.ts';
import { authorizeGitHubOperation, classifyGitHubOperation } from '../../../tools/github/policy.ts';
import {
  githubAssignmentAcknowledgmentComment,
  githubAssignmentAcknowledgmentMarker,
  GitHubAssignmentAcknowledgmentError,
} from '../utils/acknowledgment.ts';
import type {
  GitHubNotificationDeliveryState,
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../utils/monitor-state.ts';
import type { GitHubNotificationAssignmentAuthority } from './assignment-orchestrator.ts';
import type GitHubNotificationMonitorCycleLeaseStore from './monitor-cycle-lease.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';
import type GitHubNotificationSessionService from './session-service.ts';
import GitHubWorkEventClient, {
  GitHubWorkEventClientError,
  type GitHubIssueCommentReceipt,
} from './work-event-client.ts';

const cycleLeaseWaitMs = 30_000;

interface PendingAcknowledgment {
  delivery: GitHubNotificationDeliveryState;
  item: GitHubNotificationItemState;
  state: GitHubNotificationMonitorState;
  worktree: { branch: string; path: string };
}

type PendingAcknowledgmentItem = GitHubNotificationItemState & {
  delivery: GitHubNotificationDeliveryState & {
    sessionKey: string;
    worktreeBranch: string;
    worktreePath: string;
  };
};

function hasPendingAcknowledgment(
  item: GitHubNotificationItemState | undefined,
): item is PendingAcknowledgmentItem {
  const delivery = item?.delivery;
  return (
    item?.disposition === 'approved' &&
    delivery?.stage === 'active' &&
    delivery.acknowledgment?.status === 'pending' &&
    delivery.sessionKey !== undefined &&
    delivery.worktreeBranch !== undefined &&
    delivery.worktreePath !== undefined
  );
}

export interface GitHubNotificationAcknowledgmentServiceDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  authority: GitHubNotificationAssignmentAuthority;
  leaseStore: Pick<GitHubNotificationMonitorCycleLeaseStore, 'acquire'>;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  sessions: Pick<GitHubNotificationSessionService, 'generateAcknowledgment'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
}

export type GitHubNotificationAcknowledgmentScheduleStatus =
  'already-scheduled' | 'inactive' | 'scheduled';

export interface GitHubNotificationAcknowledgmentDrainResult {
  pending: number;
  scheduled: number;
  status: 'active' | 'inactive';
}

class GitHubNotificationAcknowledgmentServiceError extends Error {
  override name = 'GitHubNotificationAcknowledgmentServiceError';

  constructor(readonly code: string) {
    super('The GitHub assignment acknowledgment could not be published.');
  }
}

function errorCode(error: unknown): string {
  if (error instanceof GitHubNotificationAcknowledgmentServiceError) return error.code;
  if (error instanceof GitHubAssignmentAcknowledgmentError) return error.code;
  if (error instanceof GitHubWorkEventClientError) return error.code;
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('github-')
  ) {
    return error.code;
  }
  return 'github-notification-acknowledgment-failed';
}

/** Generate and publish assignment acknowledgments outside deterministic intake. */
export default class GitHubNotificationAcknowledgmentService {
  readonly #controllers = new Map<string, AbortController>();
  readonly #dependencies: GitHubNotificationAcknowledgmentServiceDependencies;
  readonly #inFlight = new Map<string, { agentId: string; task: Promise<void> }>();

  constructor(dependencies: GitHubNotificationAcknowledgmentServiceDependencies) {
    this.#dependencies = dependencies;
  }

  start(agentId: string): void {
    const current = this.#controllers.get(agentId);
    if (!current || current.signal.aborted) this.#controllers.set(agentId, new AbortController());
  }

  async drain(agentId: string): Promise<GitHubNotificationAcknowledgmentDrainResult> {
    const controller = this.#controllers.get(agentId);
    if (!controller || controller.signal.aborted) {
      return { pending: 0, scheduled: 0, status: 'inactive' };
    }
    const state = await this.#dependencies.stateStore.read(agentId);
    const itemKeys = state
      ? Object.entries(state.items)
          .filter(([, item]) => hasPendingAcknowledgment(item))
          .map(([itemKey]) => itemKey)
          .sort()
      : [];
    const scheduled = itemKeys.filter(
      (itemKey) => this.schedule(agentId, itemKey) === 'scheduled',
    ).length;
    if (itemKeys.length > 0) {
      this.#dependencies.logger.info(
        `github-notifications: acknowledgment drain agent=${agentId} pending=${itemKeys.length} scheduled=${scheduled}`,
      );
    }
    return { pending: itemKeys.length, scheduled, status: 'active' };
  }

  schedule(agentId: string, itemKey: string): GitHubNotificationAcknowledgmentScheduleStatus {
    const key = `${agentId}:${itemKey}`;
    const controller = this.#controllers.get(agentId);
    if (!controller || controller.signal.aborted) return 'inactive';
    if (this.#inFlight.has(key)) return 'already-scheduled';
    const task = this.#run(agentId, itemKey, controller.signal)
      .catch(async (error: unknown) => {
        if (controller.signal.aborted) return;
        const code = errorCode(error);
        await this.#recordFailure(agentId, itemKey, code, controller.signal).catch(() => undefined);
        this.#dependencies.logger.warn(
          `github-notifications: acknowledgment deferred agent=${agentId} code=${code}`,
        );
      })
      .finally(() => {
        if (this.#inFlight.get(key)?.task === task) this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, { agentId, task });
    return 'scheduled';
  }

  async stop(agentId: string): Promise<void> {
    const controller = this.#controllers.get(agentId);
    if (!controller) return;
    controller.abort();
    await this.settle(agentId);
    if (this.#controllers.get(agentId) === controller) this.#controllers.delete(agentId);
  }

  async settle(agentId?: string): Promise<void> {
    await Promise.allSettled(
      [...this.#inFlight.values()]
        .filter((entry) => agentId === undefined || entry.agentId === agentId)
        .map(({ task }) => task),
    );
  }

  async #run(agentId: string, itemKey: string, signal: AbortSignal): Promise<void> {
    this.#logStage(agentId, 'lease-acquiring');
    const acknowledgmentLease = await this.#dependencies.leaseStore.acquire(agentId, {
      scope: 'acknowledgment',
      signal,
    });
    if (acknowledgmentLease.status !== 'acquired') {
      if (!signal.aborted) {
        this.#dependencies.logger.warn(
          `github-notifications: acknowledgment deferred agent=${agentId} code=github-notification-acknowledgment-lease-${acknowledgmentLease.status}`,
        );
      }
      return;
    }
    try {
      this.#logStage(agentId, 'lease-acquired');
      const pending = await this.#loadPending(agentId, itemKey);
      if (!pending) {
        this.#logStage(agentId, 'pending-state-missing');
        return;
      }
      this.#logStage(agentId, 'manifest-loading');
      const loaded = await this.#loadManifest(agentId, pending.state.workspaceDir);
      this.#logStage(agentId, 'github-connecting');
      const connected = await this.#dependencies.accountClient.connect(
        { manifest: loaded.manifest, workspaceDir: pending.state.workspaceDir },
        'service',
        signal,
      );
      const client = new GitHubWorkEventClient(connected);
      const marker = githubAssignmentAcknowledgmentMarker(pending.delivery.assignmentEventId);
      this.#logStage(agentId, 'duplicate-checking');
      const existing = await client.findOwnIssueComment(
        pending.item.repositoryOwner,
        pending.item.repositoryName,
        pending.item.number,
        marker,
      );
      if (existing) {
        this.#logStage(agentId, 'receipt-adopting');
        if (await this.#checkpointReceipt(agentId, itemKey, existing, signal)) {
          this.#logStage(agentId, 'completed');
        }
        return;
      }
      this.#logStage(agentId, 'generation-starting');
      const text = await this.#dependencies.sessions.generateAcknowledgment({
        agentId,
        delivery: pending.delivery,
        item: pending.item,
        signal,
        workspaceDir: pending.state.workspaceDir,
        worktree: pending.worktree,
      });
      this.#logStage(agentId, 'generation-completed');
      if (await this.#publish(agentId, itemKey, text, marker, signal)) {
        this.#logStage(agentId, 'completed');
      }
    } finally {
      await acknowledgmentLease.lease.release();
    }
  }

  async #publish(
    agentId: string,
    itemKey: string,
    text: string,
    marker: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.#logStage(agentId, 'publication-lease-acquiring');
    const cycleLease = await this.#acquireCycleLease(agentId, signal);
    if (!cycleLease) return false;
    try {
      this.#logStage(agentId, 'publication-lease-acquired');
      this.#logStage(agentId, 'publication-authorizing');
      const pending = await this.#loadPending(agentId, itemKey);
      if (!pending) {
        this.#logStage(agentId, 'pending-state-missing');
        return false;
      }
      const authority = await this.#dependencies.authority.inspect({
        agentId,
        delivery: pending.delivery,
        item: pending.item,
        signal,
        workspaceDir: pending.state.workspaceDir,
      });
      if (!authority.authorized) {
        throw new GitHubNotificationAcknowledgmentServiceError(
          authority.reasonCode ?? 'github-notification-acknowledgment-authority-revoked',
        );
      }
      const loaded = await this.#loadManifest(agentId, pending.state.workspaceDir);
      const endpoint = `/repos/${pending.item.repositoryOwner}/${pending.item.repositoryName}/issues/${pending.item.number}/comments`;
      const operation = classifyGitHubOperation({
        argv: ['api', '--method', 'POST', endpoint, '--input', '-'],
      });
      const configuration = loaded.manifest.github;
      if (
        !configuration ||
        authorizeGitHubOperation(operation, configuration).status !== 'allowed'
      ) {
        throw new GitHubNotificationAcknowledgmentServiceError(
          'github-notification-acknowledgment-policy-denied',
        );
      }
      const connected = await this.#dependencies.accountClient.connect(
        { manifest: loaded.manifest, workspaceDir: pending.state.workspaceDir },
        'service',
        signal,
      );
      const client = new GitHubWorkEventClient(connected);
      this.#logStage(agentId, 'publication-reconciling');
      const existing = await client.findOwnIssueComment(
        pending.item.repositoryOwner,
        pending.item.repositoryName,
        pending.item.number,
        marker,
      );
      const receipt =
        existing ??
        (await client.createIssueComment(
          pending.item.repositoryOwner,
          pending.item.repositoryName,
          pending.item.number,
          githubAssignmentAcknowledgmentComment(text, marker),
        ));
      await this.#writeReceipt(pending.state, itemKey, receipt);
      this.#logStage(agentId, existing ? 'receipt-adopted' : 'comment-published');
      return true;
    } finally {
      await cycleLease.release();
    }
  }

  async #checkpointReceipt(
    agentId: string,
    itemKey: string,
    receipt: GitHubIssueCommentReceipt,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.#logStage(agentId, 'publication-lease-acquiring');
    const cycleLease = await this.#acquireCycleLease(agentId, signal);
    if (!cycleLease) return false;
    try {
      this.#logStage(agentId, 'publication-lease-acquired');
      const pending = await this.#loadPending(agentId, itemKey);
      if (!pending) return false;
      await this.#writeReceipt(pending.state, itemKey, receipt);
      return true;
    } finally {
      await cycleLease.release();
    }
  }

  async #writeReceipt(
    state: GitHubNotificationMonitorState,
    itemKey: string,
    receipt: GitHubIssueCommentReceipt,
  ): Promise<void> {
    const delivery = state.items[itemKey]?.delivery;
    if (!delivery || delivery.acknowledgment?.status !== 'pending') return;
    const next = {
      ...delivery,
      acknowledgment: { commentId: receipt.databaseId, status: 'published' as const },
    };
    Reflect.deleteProperty(next, 'failureCode');
    state.items[itemKey] = { ...state.items[itemKey]!, delivery: next };
    await this.#dependencies.stateStore.write(state);
  }

  async #recordFailure(
    agentId: string,
    itemKey: string,
    code: string,
    signal: AbortSignal,
  ): Promise<void> {
    const cycleLease = await this.#acquireCycleLease(agentId, signal);
    if (!cycleLease) return;
    try {
      const pending = await this.#loadPending(agentId, itemKey);
      if (!pending) return;
      pending.state.items[itemKey] = {
        ...pending.item,
        delivery: { ...pending.delivery, failureCode: code },
      };
      await this.#dependencies.stateStore.write(pending.state);
    } finally {
      await cycleLease.release();
    }
  }

  async #acquireCycleLease(agentId: string, signal: AbortSignal) {
    const acquisition = await this.#dependencies.leaseStore.acquire(agentId, {
      scope: 'cycle',
      signal,
      waitMs: cycleLeaseWaitMs,
    });
    if (acquisition.status !== 'acquired' && !signal.aborted) {
      this.#dependencies.logger.warn(
        `github-notifications: acknowledgment deferred agent=${agentId} code=github-notification-acknowledgment-publication-lease-${acquisition.status}`,
      );
    }
    return acquisition.status === 'acquired' ? acquisition.lease : undefined;
  }

  #logStage(agentId: string, stage: string): void {
    this.#dependencies.logger.info(
      `github-notifications: acknowledgment progress agent=${agentId} stage=${stage}`,
    );
  }

  async #loadManifest(agentId: string, workspaceDir: string) {
    const loaded = await this.#dependencies.manifestService.loadForAgentId(agentId, 'service');
    if (loaded.status !== 'loaded' || loaded.scope.workspaceDir !== workspaceDir) {
      throw new GitHubNotificationAcknowledgmentServiceError(
        'github-notification-acknowledgment-manifest-unavailable',
      );
    }
    return loaded;
  }

  async #loadPending(agentId: string, itemKey: string): Promise<PendingAcknowledgment | undefined> {
    const current = await this.#dependencies.stateStore.read(agentId);
    if (!current) return undefined;
    const state = structuredClone(current);
    const item = state.items[itemKey];
    if (!hasPendingAcknowledgment(item)) return undefined;
    const { delivery } = item;
    return {
      delivery,
      item,
      state,
      worktree: { branch: delivery.worktreeBranch, path: delivery.worktreePath },
    };
  }
}
