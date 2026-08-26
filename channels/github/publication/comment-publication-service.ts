import { resolve } from 'node:path';

import type AgentManifestService from '../../../manifest/service.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import { authorizeGitHubOperation, classifyGitHubOperation } from '../../../tools/github/policy.ts';
import { admitGitHubComment, githubCommentRevision } from '../conversation/comment-admission.ts';
import type {
  GitHubNotificationCommentRevisionState,
  GitHubNotificationConversationSource,
  GitHubNotificationConversationState,
  GitHubNotificationPublicationState,
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

type PublishablePublication = Exclude<GitHubNotificationPublicationState, { status: 'withheld' }>;

interface LocalPublicationMatchBase {
  conversationId: string;
  itemKey: string;
}

type LocalPublicationMatch = LocalPublicationMatchBase &
  (
    | {
        kind: 'assignment-response' | 'initial-acknowledgment';
        publication: PublishablePublication;
      }
    | {
        kind: 'pull-request-handoff';
        publication: PublishablePublication;
        publicationId: string;
      }
    | {
        commentNodeId: string;
        kind: 'reply';
        revision: GitHubNotificationCommentRevisionState & {
          publication: PublishablePublication;
        };
      }
  );

type PublicationMatch = LocalPublicationMatch & {
  destination: GitHubNotificationConversationSource;
  item: GitHubNotificationItemState;
  state: GitHubNotificationConversationState;
};

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
): LocalPublicationMatch[] {
  const matches: LocalPublicationMatch[] = [];
  for (const [conversationId, conversation] of Object.entries(state.conversations)) {
    if (conversation.acknowledgment?.target === target) {
      matches.push({
        conversationId,
        itemKey: conversation.itemKey,
        kind: 'initial-acknowledgment',
        publication: conversation.acknowledgment,
      });
    }
    if (
      conversation.assignmentResponse?.status !== 'withheld' &&
      conversation.assignmentResponse?.target === target
    ) {
      matches.push({
        conversationId,
        itemKey: conversation.itemKey,
        kind: 'assignment-response',
        publication: conversation.assignmentResponse,
      });
    }
    const pullRequest = conversation.deliveryPullRequest;
    if (pullRequest?.handoff?.target === target) {
      matches.push({
        conversationId,
        itemKey: conversation.itemKey,
        kind: 'pull-request-handoff',
        publication: pullRequest.handoff,
        publicationId: pullRequest.nodeId,
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
        if (authorized.kind !== 'reply') {
          return { client: opened.client };
        }
        const exact = await opened.client.getIssueComment(
          authorized.item.repositoryOwner,
          authorized.item.repositoryName,
          authorized.destination.number,
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
    if (match.kind === 'reply') {
      return {
        conversationId: match.conversationId,
        intent: 'github-reply' as const,
        item: { ...match.item, number: match.destination.number },
        source: {
          commentDatabaseId: match.revision.commentDatabaseId,
          revisionId: match.revision.revisionId,
        },
        text: match.revision.publication.publicText,
      };
    }
    return {
      conversationId: match.conversationId,
      intent: match.kind,
      item: { ...match.item, number: match.destination.number },
      publicationId:
        match.kind === 'pull-request-handoff'
          ? match.publicationId
          : match.item.intake!.assignmentEventId,
      text: match.publication.publicText,
    };
  }

  async #authorizeLocal(
    input: GitHubNotificationCommentPublicationServiceInput,
  ): Promise<PublicationMatch> {
    const normalizedAccountId = accountId(input.accountId);
    const parsed = parseGitHubNotificationPublicationTarget(input.target);
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
    const destination = !item
      ? undefined
      : candidate.kind === 'reply'
        ? candidate.revision.source
        : { itemType: item.itemType, number: item.number };
    const intakeReady =
      item?.intake !== undefined &&
      (parsed.intent === 'initial-acknowledgment'
        ? item.intake.stage === 'admitted' || item.intake.stage === 'prepared'
        : item.intake.stage === 'prepared');
    const targetMatches =
      item && parsed.intent === 'github-reply' && candidate.kind === 'reply'
        ? githubNotificationPublicationTarget({
            conversationId: candidate.conversationId,
            intent: 'github-reply',
            source: {
              commentDatabaseId: candidate.revision.commentDatabaseId,
              revisionId: candidate.revision.revisionId,
            },
          }) === input.target
        : item && parsed.intent !== 'github-reply' && candidate.kind === parsed.intent
          ? githubNotificationPublicationTarget({
              conversationId: candidate.conversationId,
              intent: parsed.intent,
              publicationId:
                candidate.kind === 'pull-request-handoff'
                  ? candidate.publicationId
                  : (item.intake?.assignmentEventId ?? ''),
            }) === input.target
          : false;
    const publicText =
      candidate.kind === 'reply'
        ? candidate.revision.publication.publicText
        : candidate.publication.publicText;
    const destinationMatches =
      item &&
      conversation &&
      destination &&
      ((destination.itemType === item.itemType && destination.number === item.number) ||
        (destination.itemType === 'pull-request' &&
          item.lifecycleId === 'issue' &&
          conversation.deliveryPullRequest?.number === destination.number &&
          conversation.deliveryPullRequest.status === 'open'));
    if (
      !item ||
      item.disposition !== 'approved' ||
      !intakeReady ||
      (parsed.intent !== 'initial-acknowledgment' && item.lifecycleId !== 'issue') ||
      candidate.conversationId !== parsed.conversationId ||
      conversation?.itemKey !== candidate.itemKey ||
      conversation.lifecycleId !== item.lifecycleId ||
      !destination ||
      !destinationMatches ||
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
    const endpoint = `/repos/${item.repositoryOwner}/${item.repositoryName}/issues/${destination.number}/comments`;
    const operation = classifyGitHubOperation({
      argv: ['api', '--method', 'POST', endpoint, '--input', '-'],
    });
    if (authorizeGitHubOperation(operation, loaded.manifest.github).status !== 'allowed') {
      fail('github-notification-publication-policy-denied');
    }
    return {
      ...candidate,
      destination,
      item,
      state: conversationState,
    };
  }
}
