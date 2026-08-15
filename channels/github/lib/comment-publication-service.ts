import { resolve } from 'node:path';

import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import { authorizeGitHubOperation, classifyGitHubOperation } from '../../../tools/github/policy.ts';
import { admitGitHubComment, githubCommentRevision } from '../utils/comment-admission.ts';
import type {
  GitHubNotificationCommentPublicationState,
  GitHubNotificationCommentRevisionState,
  GitHubNotificationConversationState,
} from '../utils/conversation-state.ts';
import type { GitHubNotificationItemState } from '../utils/monitor-state.ts';
import {
  githubNotificationPublicationTarget,
  githubNotificationPublicationText,
  parseGitHubNotificationPublicationTarget,
} from '../utils/publication.ts';
import { resolveNotificationRoute } from '../utils/routing.ts';
import GitHubNotificationCommentPublisher, {
  type GitHubNotificationCommentPublicationResult,
} from './comment-publisher.ts';
import type GitHubNotificationAssignmentProvider from './assignment-provider.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';
import type GitHubNotificationPublicationLeaseStore from './publication-lease.ts';

type PublishablePublication = Exclude<
  GitHubNotificationCommentPublicationState,
  { status: 'withheld' }
>;

interface PublicationMatch {
  commentNodeId: string;
  conversationId: string;
  item: GitHubNotificationItemState;
  itemKey: string;
  revision: GitHubNotificationCommentRevisionState & { publication: PublishablePublication };
  state: GitHubNotificationConversationState;
}

export interface GitHubNotificationCommentPublicationServiceDependencies {
  assignmentAuthority: Pick<GitHubNotificationAssignmentProvider, 'open'>;
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  monitorStateStore: Pick<GitHubNotificationMonitorStateStore, 'read'>;
  publicationLeaseStore: Pick<GitHubNotificationPublicationLeaseStore, 'exclusive'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

export interface GitHubNotificationCommentPublicationServiceInput {
  accountId: string;
  signal?: AbortSignal;
  target: string;
  text: string;
}

export class GitHubNotificationCommentPublicationServiceError extends Error {
  override name = 'GitHubNotificationCommentPublicationServiceError';

  constructor(readonly code: string) {
    super('The GitHub notification publication is not currently authorized.');
  }
}

function fail(code: string): never {
  throw new GitHubNotificationCommentPublicationServiceError(code);
}

function accountId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) {
    fail('github-notification-publication-account-invalid');
  }
  return normalized;
}

function publicationMatches(
  state: GitHubNotificationConversationState,
  target: string,
): Array<{
  commentNodeId: string;
  conversationId: string;
  itemKey: string;
  revision: GitHubNotificationCommentRevisionState & { publication: PublishablePublication };
}> {
  const matches = [];
  for (const [conversationId, conversation] of Object.entries(state.conversations)) {
    for (const [commentNodeId, revision] of Object.entries(conversation.revisions)) {
      const publication = revision.publication;
      if (
        revision.status === 'responded' &&
        publication &&
        publication.status !== 'withheld' &&
        publication.target === target
      ) {
        matches.push({
          commentNodeId,
          conversationId,
          itemKey: conversation.itemKey,
          revision: { ...revision, publication },
        });
      }
    }
  }
  return matches;
}

/** Reauthorize and publish only accepted lifecycle-owned GitHub reply text. */
export default class GitHubNotificationCommentPublicationService {
  readonly #dependencies: GitHubNotificationCommentPublicationServiceDependencies;

  constructor(dependencies: GitHubNotificationCommentPublicationServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async publish(
    input: GitHubNotificationCommentPublicationServiceInput,
  ): Promise<GitHubNotificationCommentPublicationResult> {
    return this.#publisher(input).publish(await this.#publicationInput(input));
  }

  async reconcile(
    input: GitHubNotificationCommentPublicationServiceInput,
  ): Promise<GitHubNotificationCommentPublicationResult | undefined> {
    return this.#publisher(input).reconcile(await this.#publicationInput(input));
  }

  #publisher(input: GitHubNotificationCommentPublicationServiceInput) {
    let authorized: PublicationMatch | undefined;
    return new GitHubNotificationCommentPublisher({
      authorize: async () => {
        authorized = await this.#authorizeLocal(input);
        return { authorized: true };
      },
      connect: async () => {
        if (!authorized) fail('github-notification-publication-authority-missing');
        const intake = authorized.item.intake;
        if (!intake) fail('github-notification-publication-intake-missing');
        const opened = await this.#dependencies.assignmentAuthority.open({
          agentId: authorized.state.agentId,
          intake,
          item: authorized.item,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          workspaceDir: authorized.state.workspaceDir,
        });
        if (!opened.authorized) {
          fail(opened.reasonCode ?? 'github-notification-publication-authority-revoked');
        }
        const exact = await opened.client.getIssueComment(
          authorized.item.repositoryOwner,
          authorized.item.repositoryName,
          authorized.item.number,
          authorized.revision.commentDatabaseId,
        );
        const current = githubCommentRevision(exact);
        const admission = admitGitHubComment({
          account: opened.client.identity,
          comment: exact,
          configuration: opened.configuration,
        });
        if (
          admission.disposition !== 'approved' ||
          exact.nodeId !== authorized.commentNodeId ||
          current.revisionId !== authorized.revision.revisionId ||
          current.bodyDigest !== authorized.revision.bodyDigest
        ) {
          fail(
            admission.disposition === 'approved'
              ? 'github-notification-publication-source-changed'
              : admission.code,
          );
        }
        return opened.client;
      },
      exclusive: (target, run) =>
        this.#dependencies.publicationLeaseStore.exclusive(
          accountId(input.accountId),
          target,
          input.signal,
          run,
        ),
    });
  }

  async #publicationInput(input: GitHubNotificationCommentPublicationServiceInput) {
    const match = await this.#authorizeLocal(input);
    return {
      intent: 'github-reply' as const,
      item: match.item,
      source: {
        commentDatabaseId: match.revision.commentDatabaseId,
        revisionId: match.revision.revisionId,
      },
      text: match.revision.publication.publicText,
    };
  }

  async #authorizeLocal(
    input: GitHubNotificationCommentPublicationServiceInput,
  ): Promise<PublicationMatch> {
    const normalizedAccountId = accountId(input.accountId);
    const text = githubNotificationPublicationText('github-reply', [{ text: input.text }]);
    const parsed = parseGitHubNotificationPublicationTarget(input.target);
    if (parsed.intent !== 'github-reply') {
      fail('github-notification-publication-intent-unsupported');
    }
    const [conversationState, monitorState, config, loaded] = await Promise.all([
      this.#dependencies.conversationStateStore.read(normalizedAccountId),
      this.#dependencies.monitorStateStore.read(normalizedAccountId),
      this.#dependencies.readConfig(),
      this.#dependencies.manifestService.loadForAgentId(normalizedAccountId, 'service'),
    ]);
    if (
      !conversationState ||
      !monitorState ||
      conversationState.workspaceDir !== monitorState.workspaceDir ||
      loaded.status !== 'loaded' ||
      loaded.manifest.agent.id !== normalizedAccountId ||
      resolve(loaded.scope.workspaceDir) !== resolve(conversationState.workspaceDir) ||
      !loaded.manifest.github?.notifications
    ) {
      fail('github-notification-publication-state-missing');
    }
    const matches = publicationMatches(conversationState, input.target);
    if (matches.length !== 1 || !matches[0]) {
      fail('github-notification-publication-target-not-admitted');
    }
    const candidate = matches[0];
    const item = monitorState.items[candidate.itemKey];
    if (
      !item ||
      item.disposition !== 'approved' ||
      item.intake?.stage !== 'prepared' ||
      item.lifecycleId !== 'issue' ||
      candidate.conversationId !== parsed.conversationId ||
      candidate.revision.publication?.publicText !== text ||
      githubNotificationPublicationTarget({
        intent: 'github-reply',
        item,
        source: {
          commentDatabaseId: candidate.revision.commentDatabaseId,
          revisionId: candidate.revision.revisionId,
        },
      }) !== input.target
    ) {
      fail('github-notification-publication-target-not-admitted');
    }
    try {
      resolveNotificationRoute(
        config,
        {
          agentId: normalizedAccountId,
          enabled: true,
          workspaceDir: conversationState.workspaceDir,
        },
        candidate.conversationId,
      );
    } catch {
      fail('github-notification-publication-route-revoked');
    }
    const endpoint = `/repos/${item.repositoryOwner}/${item.repositoryName}/issues/${item.number}/comments`;
    const operation = classifyGitHubOperation({
      argv: ['api', '--method', 'POST', endpoint, '--input', '-'],
    });
    if (authorizeGitHubOperation(operation, loaded.manifest.github).status !== 'allowed') {
      fail('github-notification-publication-policy-denied');
    }
    return {
      ...candidate,
      item,
      state: conversationState,
    };
  }
}
