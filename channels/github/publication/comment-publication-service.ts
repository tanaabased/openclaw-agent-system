import { resolve } from 'node:path';

import type AgentManifestService from '../../../manifest/service.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import { authorizeGitHubOperation, classifyGitHubOperation } from '../../../tools/github/policy.ts';
import { admitGitHubComment, githubCommentRevision } from '../conversation/comment-admission.ts';
import type {
  GitHubNotificationCommentPublicationState,
  GitHubNotificationCommentRevisionState,
  GitHubNotificationConversationState,
} from '../conversation/conversation-state.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import {
  githubNotificationPublicationTarget,
  githubNotificationPublicationText,
  parseGitHubNotificationPublicationTarget,
} from './publication.ts';
import { resolveNotificationRoute } from '../routing/routing.ts';
import GitHubNotificationCommentPublisher, {
  type GitHubNotificationCommentPublicationResult,
} from './comment-publisher.ts';
import type { GitHubNotificationAssignmentProviderAuthority } from '../intake/assignment-provider.ts';
import type GitHubNotificationConversationStateStore from '../conversation/conversation-state-store.ts';
import type GitHubNotificationMonitorStateStore from '../intake/monitor/state-store.ts';
import type GitHubNotificationPublicationLeaseStore from './publication-lease.ts';
import type { GitHubNotificationPublicationClient } from '../provider/work-event-client.ts';

type PublishablePublication = Exclude<
  GitHubNotificationCommentPublicationState,
  { status: 'withheld' }
>;

interface PublicationMatchBase {
  conversationId: string;
  item: GitHubNotificationItemState;
  itemKey: string;
  state: GitHubNotificationConversationState;
}

type PublicationMatch = PublicationMatchBase &
  (
    | {
        kind: 'acknowledgment';
        publication: PublishablePublication;
      }
    | {
        commentNodeId: string;
        kind: 'reply';
        revision: GitHubNotificationCommentRevisionState & {
          publication: PublishablePublication;
        };
      }
  );

interface LocalPublicationMatch {
  commentNodeId: string;
  conversationId: string;
  itemKey: string;
  revision: GitHubNotificationCommentRevisionState & { publication: PublishablePublication };
}

export interface GitHubNotificationCommentPublicationServiceDependencies {
  assignmentAuthority: GitHubNotificationAssignmentProviderAuthority<GitHubNotificationPublicationClient>;
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
): Array<
  | {
      conversationId: string;
      itemKey: string;
      kind: 'acknowledgment';
      publication: PublishablePublication;
    }
  | (LocalPublicationMatch & { kind: 'reply' })
> {
  const matches: Array<
    | {
        conversationId: string;
        itemKey: string;
        kind: 'acknowledgment';
        publication: PublishablePublication;
      }
    | (LocalPublicationMatch & { kind: 'reply' })
  > = [];
  for (const [conversationId, conversation] of Object.entries(state.conversations)) {
    if (conversation.acknowledgment?.target === target) {
      matches.push({
        conversationId,
        itemKey: conversation.itemKey,
        kind: 'acknowledgment',
        publication: conversation.acknowledgment,
      });
    }
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
          kind: 'reply',
          revision: { ...revision, publication },
        });
      }
    }
  }
  return matches;
}

/** Reauthorize and publish only accepted lifecycle-owned GitHub comment text. */
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
        if (authorized.kind === 'acknowledgment') {
          return { client: opened.client };
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
        const commenter = exact.author;
        if (!commenter) fail('comment-actor-missing');
        return { client: opened.client, commenterLogin: commenter.login };
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
    return match.kind === 'reply'
      ? {
          intent: 'github-reply' as const,
          item: match.item,
          source: {
            commentDatabaseId: match.revision.commentDatabaseId,
            revisionId: match.revision.revisionId,
          },
          text: match.revision.publication.publicText,
        }
      : {
          intent: 'initial-acknowledgment' as const,
          item: match.item,
          publicationId: match.item.intake!.assignmentEventId,
          text: match.publication.publicText,
        };
  }

  async #authorizeLocal(
    input: GitHubNotificationCommentPublicationServiceInput,
  ): Promise<PublicationMatch> {
    const normalizedAccountId = accountId(input.accountId);
    const parsed = parseGitHubNotificationPublicationTarget(input.target);
    if (parsed.intent !== 'github-reply' && parsed.intent !== 'initial-acknowledgment') {
      fail('github-notification-publication-intent-unsupported');
    }
    const text = githubNotificationPublicationText(parsed.intent, [{ text: input.text }]);
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
    const conversation = conversationState.conversations[candidate.conversationId];
    const intakeReady =
      item?.intake !== undefined &&
      (parsed.intent === 'initial-acknowledgment'
        ? item.intake.stage === 'admitted' || item.intake.stage === 'prepared'
        : item.intake.stage === 'prepared');
    const targetMatches =
      item && parsed.intent === 'github-reply' && candidate.kind === 'reply'
        ? githubNotificationPublicationTarget({
            intent: 'github-reply',
            item,
            source: {
              commentDatabaseId: candidate.revision.commentDatabaseId,
              revisionId: candidate.revision.revisionId,
            },
          }) === input.target
        : item && parsed.intent === 'initial-acknowledgment' && candidate.kind === 'acknowledgment'
          ? githubNotificationPublicationTarget({
              intent: 'initial-acknowledgment',
              item,
              publicationId: item.intake?.assignmentEventId ?? '',
            }) === input.target
          : false;
    const publicText =
      candidate.kind === 'reply'
        ? candidate.revision.publication.publicText
        : candidate.publication.publicText;
    if (
      !item ||
      item.disposition !== 'approved' ||
      !intakeReady ||
      (parsed.intent === 'github-reply' && item.lifecycleId !== 'issue') ||
      candidate.conversationId !== parsed.conversationId ||
      conversation?.itemKey !== candidate.itemKey ||
      conversation.lifecycleId !== item.lifecycleId ||
      publicText !== text ||
      !targetMatches
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
