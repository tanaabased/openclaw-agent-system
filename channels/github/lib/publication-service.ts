import {
  deliverInboundReplyWithMessageSendContext,
  type DurableInboundReplyDeliveryResult,
} from 'openclaw/plugin-sdk/channel-outbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import type { AssembledInboundReply } from 'openclaw/plugin-sdk/channel-inbound';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import type { GitHubNotificationItemState } from '../utils/monitor-state.ts';
import {
  githubNotificationPublicationTarget,
  githubNotificationPublicationText,
  type GitHubNotificationPublicationIntent,
} from '../utils/publication.ts';
import { githubNotificationChannelId } from '../utils/routing.ts';

type Delivery = AssembledInboundReply['delivery']['deliver'];

/** Read a confirmed numeric GitHub comment receipt from durable delivery. */
export function githubNotificationPublishedCommentId(
  result: DurableInboundReplyDeliveryResult,
): number | undefined {
  if (result.status !== 'handled_visible') return undefined;
  const value =
    result.delivery.messageIds?.[0] ?? result.delivery.receipt?.primaryPlatformMessageId;
  if (!value || !/^[1-9]\d*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export interface GitHubNotificationPublicationServiceDependencies {
  deliver?: typeof deliverInboundReplyWithMessageSendContext;
}

export interface GitHubNotificationPublicationInput {
  accountId: string;
  agentId: string;
  cfg: OpenClawConfig;
  ctxPayload: AssembledInboundReply['ctxPayload'];
  info: Parameters<Delivery>[1];
  intent: GitHubNotificationPublicationIntent;
  item: Pick<GitHubNotificationItemState, 'number' | 'repositoryNodeId'>;
  payload: ReplyPayload;
  publicationId: string;
}

export interface GitHubNotificationPublications {
  publish(input: GitHubNotificationPublicationInput): Promise<DurableInboundReplyDeliveryResult>;
}

/** Route an explicit GitHub publication intent through OpenClaw's durable send lifecycle. */
export default class GitHubNotificationPublicationService implements GitHubNotificationPublications {
  readonly #deliver: typeof deliverInboundReplyWithMessageSendContext;

  constructor(dependencies: GitHubNotificationPublicationServiceDependencies = {}) {
    this.#deliver = dependencies.deliver ?? deliverInboundReplyWithMessageSendContext;
  }

  async publish(
    input: GitHubNotificationPublicationInput,
  ): Promise<DurableInboundReplyDeliveryResult> {
    const text = githubNotificationPublicationText(input.intent, [input.payload]);
    return this.#deliver({
      accountId: input.accountId,
      agentId: input.agentId,
      cfg: input.cfg,
      channel: githubNotificationChannelId,
      ctxPayload: input.ctxPayload,
      info: input.info,
      payload: { text },
      requiredCapabilities: { reconcileUnknownSend: true, text: true },
      to: githubNotificationPublicationTarget({
        intent: input.intent,
        item: input.item,
        publicationId: input.publicationId,
      }),
    });
  }
}
