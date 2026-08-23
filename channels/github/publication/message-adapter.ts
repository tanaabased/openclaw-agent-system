import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
} from 'openclaw/plugin-sdk/channel-outbound';

import { githubNotificationPublicationText } from './publication.ts';
import { githubNotificationChannelId } from '../routing/routing.ts';
import type GitHubNotificationCommentPublicationService from './comment-publication-service.ts';
import type { GitHubIssueCommentReceipt } from '../provider/work-event-client.ts';

export interface GitHubNotificationMessageAdapterDependencies {
  publications: Pick<GitHubNotificationCommentPublicationService, 'publish' | 'reconcile'>;
}

function result(to: string, receipt: GitHubIssueCommentReceipt): ChannelMessageSendResult {
  const messageId = String(receipt.databaseId);
  return {
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      kind: 'text',
      results: [
        {
          channel: githubNotificationChannelId,
          conversationId: to,
          messageId,
          meta: { nodeId: receipt.nodeId },
        },
      ],
    }),
  };
}

/** Create the GitHub comment transport for accepted public reply candidates. */
export default function createGitHubNotificationMessageAdapter(
  dependencies: GitHubNotificationMessageAdapterDependencies,
) {
  return defineChannelMessageAdapter({
    id: githubNotificationChannelId,
    durableFinal: {
      capabilities: { reconcileUnknownSend: true, text: true },
      reconcileUnknownSendKinds: { text: true },
      async reconcileUnknownSend(ctx) {
        const payload = ctx.payloads.length === 1 ? ctx.payloads[0] : undefined;
        if (!payload) return { status: 'not_sent' as const };
        const text = githubNotificationPublicationText('github-reply', [payload]);
        const publication = await dependencies.publications.reconcile({
          accountId: ctx.accountId ?? '',
          target: ctx.to,
          text,
        });
        return publication
          ? { ...result(ctx.to, publication.receipt), status: 'sent' as const }
          : { status: 'not_sent' as const };
      },
    },
    send: {
      async text(ctx) {
        const publication = await dependencies.publications.publish({
          accountId: ctx.accountId ?? '',
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          target: ctx.to,
          text: ctx.text,
        });
        return result(ctx.to, publication.receipt);
      },
    },
  });
}
