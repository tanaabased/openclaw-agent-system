import { randomUUID } from 'node:crypto';

import { buildChannelInboundEventContext } from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { githubNotificationConversationId } from '../channel.ts';
import type {
  GitHubNotificationAcknowledgmentState,
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../utils/monitor-state.ts';
import { githubNotificationPublicationText } from '../utils/publication.ts';
import { githubNotificationChannelId } from '../utils/routing.ts';
import type GitHubNotificationMonitorCycleLeaseStore from './monitor-cycle-lease.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';
import {
  githubNotificationPublishedCommentId,
  type GitHubNotificationPublications,
} from './publication-service.ts';

const cycleLeaseWaitMs = 30_000;
const maximumProgressCheckpoints = 100;

interface PendingProgress {
  item: GitHubNotificationItemState;
  itemKey: string;
  publicationId: string;
}

export interface GitHubNotificationProgressServiceDependencies {
  createPublicationId?: () => string;
  leaseStore: Pick<GitHubNotificationMonitorCycleLeaseStore, 'acquire'>;
  publicationService: GitHubNotificationPublications;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
}

export interface GitHubNotificationProgressPublishInput {
  agentId: string;
  config: OpenClawConfig;
  sessionKey: string;
  signal?: AbortSignal;
  text: string;
}

export interface GitHubNotificationProgressPublishResult {
  commentId: number;
  status: 'published';
}

export class GitHubNotificationProgressServiceError extends Error {
  override name = 'GitHubNotificationProgressServiceError';

  constructor(readonly code: string) {
    super('The GitHub notification progress update could not be published.');
  }
}

function fail(code: string): never {
  throw new GitHubNotificationProgressServiceError(code);
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
  return 'github-notification-progress-publication-failed';
}

function validAgentId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function validPublicationId(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
}

/** Publish one explicitly selected local update into the exact active issue session. */
export default class GitHubNotificationProgressService {
  readonly #createPublicationId: () => string;
  readonly #dependencies: GitHubNotificationProgressServiceDependencies;

  constructor(dependencies: GitHubNotificationProgressServiceDependencies) {
    this.#dependencies = dependencies;
    this.#createPublicationId = dependencies.createPublicationId ?? randomUUID;
  }

  async publish(
    input: GitHubNotificationProgressPublishInput,
  ): Promise<GitHubNotificationProgressPublishResult> {
    const agentId = input.agentId.trim().toLowerCase();
    const sessionKey = input.sessionKey.trim();
    if (!validAgentId(agentId)) fail('github-notification-progress-agent-invalid');
    if (!sessionKey || sessionKey.length > 1_024 || /\0/u.test(sessionKey)) {
      fail('github-notification-progress-session-invalid');
    }
    const text = githubNotificationPublicationText('operator-progress', [{ text: input.text }]);
    const pending = await this.#checkpointPending(agentId, sessionKey, input.signal);
    const conversationId = githubNotificationConversationId({
      itemNumber: pending.item.number,
      repositoryId: pending.item.repositoryNodeId,
    });
    const label = `${pending.item.repositoryOwner}/${pending.item.repositoryName}#${pending.item.number}`;
    const ctxPayload = buildChannelInboundEventContext({
      accountId: agentId,
      channel: githubNotificationChannelId,
      conversation: {
        id: conversationId,
        kind: 'direct',
        label,
        routePeer: { id: conversationId, kind: 'direct' },
      },
      from: `operator:${agentId}`,
      message: {
        body: 'Publish the selected local progress update.',
        bodyForAgent: 'Publish the selected local progress update.',
        commandBody: '',
        inboundEventKind: 'user_request',
        rawBody: 'Publish the selected local progress update.',
      },
      messageId: `progress:${pending.publicationId}`,
      reply: { sourceReplyDeliveryMode: 'none', to: conversationId },
      route: {
        accountId: agentId,
        agentId,
        createIfMissing: false,
        routeSessionKey: sessionKey,
      },
      sender: {
        displayLabel: 'Local operator',
        id: 'local-operator',
        name: 'Local operator',
      },
      surface: githubNotificationChannelId,
    });
    let publication;
    try {
      publication = await this.#dependencies.publicationService.publish({
        accountId: agentId,
        agentId,
        cfg: input.config,
        ctxPayload,
        info: { kind: 'final' },
        intent: 'operator-progress',
        item: pending.item,
        payload: { text },
        publicationId: pending.publicationId,
      });
    } catch (error) {
      const code = errorCode(error);
      await this.#checkpointResult(agentId, pending, { failureCode: code, status: 'failed' }).catch(
        () => undefined,
      );
      fail(code);
    }
    const commentId = githubNotificationPublishedCommentId(publication);
    if (commentId === undefined) {
      const code =
        publication.status === 'failed'
          ? errorCode(publication.error)
          : 'github-notification-progress-publication-not-confirmed';
      await this.#checkpointResult(agentId, pending, { failureCode: code, status: 'failed' }).catch(
        () => undefined,
      );
      fail(code);
    }
    try {
      await this.#checkpointResult(agentId, pending, { commentId, status: 'published' });
    } catch {
      fail('github-notification-progress-checkpoint-failed');
    }
    return { commentId, status: 'published' };
  }

  async #checkpointPending(
    agentId: string,
    sessionKey: string,
    signal?: AbortSignal,
  ): Promise<PendingProgress> {
    return this.#withCycleLease(agentId, signal, async () => {
      const current = await this.#dependencies.stateStore.read(agentId);
      if (!current || current.agentId !== agentId) {
        fail('github-notification-progress-state-missing');
      }
      const matches = Object.entries(current.items).filter(([, item]) => {
        const delivery = item.delivery;
        return (
          item.disposition === 'approved' &&
          item.itemType === 'issue' &&
          delivery?.stage === 'active' &&
          delivery.sessionKey === sessionKey
        );
      });
      if (matches.length !== 1) fail('github-notification-progress-session-not-active');
      const [itemKey, item] = matches[0]!;
      const progress = { ...(item.delivery!.progress ?? {}) };
      if (Object.keys(progress).length >= maximumProgressCheckpoints) {
        const terminalPublicationId = Object.entries(progress).find(
          ([, checkpoint]) => checkpoint.status !== 'pending',
        )?.[0];
        if (!terminalPublicationId) fail('github-notification-progress-capacity-exceeded');
        delete progress[terminalPublicationId];
      }
      const publicationId = this.#createPublicationId();
      if (!validPublicationId(publicationId) || progress[publicationId] !== undefined) {
        fail('github-notification-progress-publication-id-invalid');
      }
      const state = structuredClone(current);
      state.items[itemKey] = {
        ...item,
        delivery: {
          ...item.delivery!,
          progress: { ...progress, [publicationId]: { status: 'pending' } },
        },
      };
      await this.#dependencies.stateStore.write(state);
      return { item: state.items[itemKey]!, itemKey, publicationId };
    });
  }

  async #checkpointResult(
    agentId: string,
    pending: PendingProgress,
    result: GitHubNotificationAcknowledgmentState,
  ): Promise<void> {
    await this.#withCycleLease(agentId, undefined, async () => {
      const current = await this.#dependencies.stateStore.read(agentId);
      const item = current?.items[pending.itemKey];
      if (!current || !item?.delivery?.progress?.[pending.publicationId]) {
        fail('github-notification-progress-checkpoint-missing');
      }
      const state: GitHubNotificationMonitorState = structuredClone(current);
      state.items[pending.itemKey] = {
        ...item,
        delivery: {
          ...item.delivery,
          progress: { ...item.delivery.progress, [pending.publicationId]: result },
        },
      };
      await this.#dependencies.stateStore.write(state);
    });
  }

  async #withCycleLease<T>(
    agentId: string,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const acquisition = await this.#dependencies.leaseStore.acquire(agentId, {
      ...(signal === undefined ? {} : { signal }),
      waitMs: cycleLeaseWaitMs,
    });
    if (acquisition.status !== 'acquired') {
      fail(`github-notification-progress-lease-${acquisition.status}`);
    }
    try {
      return await run();
    } finally {
      await acquisition.lease.release();
    }
  }
}
