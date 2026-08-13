import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import type GitHubAccountClient from '../../../lib/github-account-client.ts';
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

export interface GitHubNotificationAcknowledgmentServiceDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  authority: GitHubNotificationAssignmentAuthority;
  leaseStore: Pick<GitHubNotificationMonitorCycleLeaseStore, 'acquire'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  sessions: Pick<GitHubNotificationSessionService, 'generateAcknowledgment'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
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
  #controller = new AbortController();
  readonly #dependencies: GitHubNotificationAcknowledgmentServiceDependencies;
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(dependencies: GitHubNotificationAcknowledgmentServiceDependencies) {
    this.#dependencies = dependencies;
  }

  start(): void {
    if (this.#controller.signal.aborted) this.#controller = new AbortController();
  }

  schedule(agentId: string, itemKey: string): void {
    const key = `${agentId}:${itemKey}`;
    if (this.#controller.signal.aborted || this.#inFlight.has(key)) return;
    const task = this.#run(agentId, itemKey)
      .catch(async (error: unknown) => {
        if (this.#controller.signal.aborted) return;
        await this.#recordFailure(agentId, itemKey, errorCode(error)).catch(() => undefined);
      })
      .finally(() => {
        if (this.#inFlight.get(key) === task) this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, task);
  }

  async stop(): Promise<void> {
    this.#controller.abort();
    await this.settle();
  }

  async settle(): Promise<void> {
    await Promise.allSettled(this.#inFlight.values());
  }

  async #run(agentId: string, itemKey: string): Promise<void> {
    const acknowledgmentLease = await this.#dependencies.leaseStore.acquire(agentId, {
      scope: 'acknowledgment',
      signal: this.#controller.signal,
    });
    if (acknowledgmentLease.status !== 'acquired') return;
    try {
      const pending = await this.#loadPending(agentId, itemKey);
      if (!pending) return;
      const loaded = await this.#loadManifest(agentId, pending.state.workspaceDir);
      const connected = await this.#dependencies.accountClient.connect(
        { manifest: loaded.manifest, workspaceDir: pending.state.workspaceDir },
        'service',
        this.#controller.signal,
      );
      const client = new GitHubWorkEventClient(connected);
      const marker = githubAssignmentAcknowledgmentMarker(pending.delivery.assignmentEventId);
      const existing = await client.findOwnIssueComment(
        pending.item.repositoryOwner,
        pending.item.repositoryName,
        pending.item.number,
        marker,
      );
      if (existing) {
        await this.#checkpointReceipt(agentId, itemKey, existing);
        return;
      }
      const text = await this.#dependencies.sessions.generateAcknowledgment({
        agentId,
        delivery: pending.delivery,
        item: pending.item,
        signal: this.#controller.signal,
        workspaceDir: pending.state.workspaceDir,
        worktree: pending.worktree,
      });
      await this.#publish(agentId, itemKey, text, marker);
    } finally {
      await acknowledgmentLease.lease.release();
    }
  }

  async #publish(agentId: string, itemKey: string, text: string, marker: string): Promise<void> {
    const cycleLease = await this.#acquireCycleLease(agentId);
    if (!cycleLease) return;
    try {
      const pending = await this.#loadPending(agentId, itemKey);
      if (!pending) return;
      const authority = await this.#dependencies.authority.inspect({
        agentId,
        delivery: pending.delivery,
        item: pending.item,
        signal: this.#controller.signal,
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
        this.#controller.signal,
      );
      const client = new GitHubWorkEventClient(connected);
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
    } finally {
      await cycleLease.release();
    }
  }

  async #checkpointReceipt(
    agentId: string,
    itemKey: string,
    receipt: GitHubIssueCommentReceipt,
  ): Promise<void> {
    const cycleLease = await this.#acquireCycleLease(agentId);
    if (!cycleLease) return;
    try {
      const pending = await this.#loadPending(agentId, itemKey);
      if (pending) await this.#writeReceipt(pending.state, itemKey, receipt);
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

  async #recordFailure(agentId: string, itemKey: string, code: string): Promise<void> {
    const cycleLease = await this.#acquireCycleLease(agentId);
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

  async #acquireCycleLease(agentId: string) {
    const acquisition = await this.#dependencies.leaseStore.acquire(agentId, {
      scope: 'cycle',
      signal: this.#controller.signal,
      waitMs: cycleLeaseWaitMs,
    });
    return acquisition.status === 'acquired' ? acquisition.lease : undefined;
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
    const delivery = item?.delivery;
    if (
      !item ||
      !delivery ||
      item.disposition !== 'approved' ||
      delivery.stage !== 'active' ||
      delivery.acknowledgment?.status !== 'pending' ||
      !delivery.sessionKey ||
      !delivery.worktreeBranch ||
      !delivery.worktreePath
    ) {
      return undefined;
    }
    return {
      delivery,
      item,
      state,
      worktree: { branch: delivery.worktreeBranch, path: delivery.worktreePath },
    };
  }
}
