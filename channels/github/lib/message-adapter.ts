import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  type ChannelMessageSendResult,
} from 'openclaw/plugin-sdk/channel-outbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import type GitHubAccountClient from '../../../lib/github-account-client.ts';
import { authorizeGitHubOperation, classifyGitHubOperation } from '../../../tools/github/policy.ts';
import { githubNotificationConversationId } from '../channel.ts';
import {
  githubNotificationPublicationComment,
  githubNotificationPublicationMarker,
  githubNotificationPublicationTarget,
  githubNotificationPublicationText,
  parseGitHubNotificationPublicationTarget,
} from '../utils/publication.ts';
import { githubNotificationChannelId, resolveNotificationRoute } from '../utils/routing.ts';
import type { GitHubNotificationAssignmentAuthority } from './assignment-orchestrator.ts';
import type GitHubNotificationMonitorCycleLeaseStore from './monitor-cycle-lease.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';
import GitHubWorkEventClient, { type GitHubIssueCommentReceipt } from './work-event-client.ts';

const cycleLeaseWaitMs = 30_000;

export interface GitHubNotificationMessageAdapterDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  authority: GitHubNotificationAssignmentAuthority;
  leaseStore: Pick<GitHubNotificationMonitorCycleLeaseStore, 'acquire'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read'>;
}

class GitHubNotificationMessageAdapterError extends Error {
  override name = 'GitHubNotificationMessageAdapterError';

  constructor(readonly code: string) {
    super('The GitHub notification message could not be delivered.');
  }
}

function fail(code: string): never {
  throw new GitHubNotificationMessageAdapterError(code);
}

function normalizedAccountId(value: string | null | undefined): string {
  const accountId = value?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(accountId)) {
    fail('github-notification-publication-account-invalid');
  }
  return accountId;
}

function messageResult(to: string, receipt: GitHubIssueCommentReceipt): ChannelMessageSendResult {
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

/** Create the deterministic GitHub transport used by every publication intent. */
export function createGitHubNotificationMessageAdapter(
  dependencies: GitHubNotificationMessageAdapterDependencies,
) {
  const resolvePublication = async (input: {
    accountId?: string | null;
    cfg: OpenClawConfig;
    signal?: AbortSignal;
    text: string;
    to: string;
  }) => {
    const accountId = normalizedAccountId(input.accountId);
    const parsed = parseGitHubNotificationPublicationTarget(input.to);
    if (parsed.intent !== 'initial-acknowledgment') {
      fail('github-notification-publication-intent-not-active');
    }
    const state = await dependencies.stateStore.read(accountId);
    if (!state || state.agentId !== accountId) {
      fail('github-notification-publication-state-missing');
    }
    const matches = Object.values(state.items).filter((item) => {
      const delivery = item.delivery;
      return (
        item.disposition === 'approved' &&
        delivery?.stage === 'active' &&
        githubNotificationConversationId({
          itemNumber: item.number,
          repositoryId: item.repositoryNodeId,
        }) === parsed.conversationId &&
        githubNotificationPublicationTarget({
          intent: parsed.intent,
          item,
          publicationId: delivery.assignmentEventId,
        }) === input.to
      );
    });
    if (matches.length !== 1) fail('github-notification-publication-target-not-admitted');
    const item = matches[0]!;
    const delivery = item.delivery!;
    try {
      resolveNotificationRoute(
        input.cfg,
        { agentId: accountId, enabled: true, workspaceDir: state.workspaceDir },
        parsed.conversationId,
      );
    } catch {
      fail('github-notification-publication-route-revoked');
    }
    const loaded = await dependencies.manifestService.loadForAgentId(accountId, 'service');
    if (
      loaded.status !== 'loaded' ||
      loaded.manifest.agent.id !== accountId ||
      loaded.scope.workspaceDir !== state.workspaceDir ||
      !loaded.manifest.github?.notifications
    ) {
      fail('github-notification-publication-manifest-unavailable');
    }
    const endpoint = `/repos/${item.repositoryOwner}/${item.repositoryName}/issues/${item.number}/comments`;
    const operation = classifyGitHubOperation({
      argv: ['api', '--method', 'POST', endpoint, '--input', '-'],
    });
    if (authorizeGitHubOperation(operation, loaded.manifest.github).status !== 'allowed') {
      fail('github-notification-publication-policy-denied');
    }
    const authority = await dependencies.authority.inspect({
      agentId: accountId,
      delivery,
      item,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      workspaceDir: state.workspaceDir,
    });
    if (!authority.authorized) {
      fail(authority.reasonCode ?? 'github-notification-publication-authority-revoked');
    }
    const connected = await dependencies.accountClient.connect(
      { manifest: loaded.manifest, workspaceDir: state.workspaceDir },
      'service',
      input.signal,
    );
    if (
      connected.identity.nodeId !== state.accountNodeId ||
      connected.identity.login.toLowerCase() !== state.accountLogin?.toLowerCase()
    ) {
      fail('github-notification-publication-identity-changed');
    }
    return {
      client: new GitHubWorkEventClient(connected),
      item,
      marker: githubNotificationPublicationMarker(input.to),
      text: githubNotificationPublicationText(parsed.intent, [{ text: input.text }]),
    };
  };

  const withCycleLease = async <T>(
    accountId: string | null | undefined,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> => {
    const normalized = normalizedAccountId(accountId);
    const acquisition = await dependencies.leaseStore.acquire(normalized, {
      scope: 'publication',
      ...(signal === undefined ? {} : { signal }),
      waitMs: cycleLeaseWaitMs,
    });
    if (acquisition.status !== 'acquired') {
      fail(`github-notification-publication-lease-${acquisition.status}`);
    }
    try {
      return await run();
    } finally {
      await acquisition.lease.release();
    }
  };

  return defineChannelMessageAdapter({
    id: githubNotificationChannelId,
    durableFinal: {
      capabilities: { reconcileUnknownSend: true, text: true },
      reconcileUnknownSendKinds: { text: true },
      async reconcileUnknownSend(ctx) {
        return withCycleLease(ctx.accountId, undefined, async () => {
          const payload = ctx.payloads.length === 1 ? ctx.payloads[0] : undefined;
          if (!payload) fail('github-notification-publication-output-count-invalid');
          const publication = await resolvePublication({
            accountId: ctx.accountId,
            cfg: ctx.cfg,
            text: githubNotificationPublicationText(
              parseGitHubNotificationPublicationTarget(ctx.to).intent,
              [payload],
            ),
            to: ctx.to,
          });
          const receipt = await publication.client.findOwnIssueComment(
            publication.item.repositoryOwner,
            publication.item.repositoryName,
            publication.item.number,
            publication.marker,
          );
          return receipt
            ? { ...messageResult(ctx.to, receipt), status: 'sent' as const }
            : { status: 'not_sent' as const };
        });
      },
    },
    send: {
      async text(ctx) {
        return withCycleLease(ctx.accountId, ctx.signal, async () => {
          const publication = await resolvePublication(ctx);
          const existing = await publication.client.findOwnIssueComment(
            publication.item.repositoryOwner,
            publication.item.repositoryName,
            publication.item.number,
            publication.marker,
          );
          const receipt =
            existing ??
            (await publication.client.createIssueComment(
              publication.item.repositoryOwner,
              publication.item.repositoryName,
              publication.item.number,
              githubNotificationPublicationComment(publication.text, publication.marker),
            ));
          return messageResult(ctx.to, receipt);
        });
      },
    },
  });
}
