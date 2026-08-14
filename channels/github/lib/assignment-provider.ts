import { resolve } from 'node:path';

import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import type {
  GitHubNotificationAssignmentAuthority,
  GitHubNotificationAssignmentBoundaryInput,
} from './assignment-orchestrator.ts';
import type GitHubAccountClient from '../../../lib/github-account-client.ts';
import type { GitHubNotificationsConfiguration } from '../config-schema.ts';
import { githubNotificationConversationId } from '../channel.ts';
import { admitGitHubAssignment } from '../utils/admit-assignment.ts';
import {
  admitGitHubComment,
  githubCommentRevision,
  type GitHubCanonicalIssueComment,
} from '../utils/comment-admission.ts';
import type { GitHubNotificationCommentRevisionState } from '../utils/monitor-state.ts';
import { resolveNotificationRoute } from '../utils/routing.ts';
import GitHubWorkEventClient, {
  GitHubWorkEventClientError,
  type GitHubNotificationPlanningContext,
} from './work-event-client.ts';

export interface GitHubNotificationAssignmentProviderDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

export type GitHubNotificationPlanningContextResult =
  | { authorized: false; reasonCode: string }
  | { authorized: true; context: GitHubNotificationPlanningContext };

type GitHubNotificationAssignmentInspection =
  | { authorized: false; reasonCode?: string }
  | {
      authorized: true;
      client: GitHubWorkEventClient;
      configuration: GitHubNotificationsConfiguration;
    };

export interface GitHubNotificationCommentBoundaryInput extends GitHubNotificationAssignmentBoundaryInput {
  comment: GitHubNotificationCommentRevisionState;
}

export type GitHubNotificationCommentContextResult =
  | { authorized: false; reasonCode: string }
  | { authorized: true; context: GitHubCanonicalIssueComment };

/** Read current GitHub authority for assignment delivery. */
export default class GitHubNotificationAssignmentProvider implements GitHubNotificationAssignmentAuthority {
  readonly #dependencies: GitHubNotificationAssignmentProviderDependencies;

  constructor(dependencies: GitHubNotificationAssignmentProviderDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(
    input: GitHubNotificationAssignmentBoundaryInput,
  ): Promise<{ authorized: boolean; reasonCode?: string }> {
    const inspection = await this.#inspect(input);
    return inspection.authorized
      ? { authorized: true }
      : {
          authorized: false,
          ...(inspection.reasonCode === undefined ? {} : { reasonCode: inspection.reasonCode }),
        };
  }

  async loadPlanningContext(
    input: GitHubNotificationAssignmentBoundaryInput,
  ): Promise<GitHubNotificationPlanningContextResult> {
    if (input.item.itemType !== 'issue') {
      return {
        authorized: false,
        reasonCode: 'github-notification-activation-pull-request-deferred',
      };
    }
    const inspection = await this.#inspect(input);
    if (!inspection.authorized) {
      return {
        authorized: false,
        reasonCode: inspection.reasonCode ?? 'github-notification-authority-revoked',
      };
    }
    return {
      authorized: true,
      context: await inspection.client.getPlanningContext(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
      ),
    };
  }

  async inspectComment(
    input: GitHubNotificationCommentBoundaryInput,
  ): Promise<{ authorized: boolean; reasonCode?: string }> {
    const result = await this.#loadComment(input);
    return result.authorized
      ? { authorized: true }
      : { authorized: false, reasonCode: result.reasonCode };
  }

  async loadCommentContext(
    input: GitHubNotificationCommentBoundaryInput,
  ): Promise<GitHubNotificationCommentContextResult> {
    return this.#loadComment(input);
  }

  async #loadComment(
    input: GitHubNotificationCommentBoundaryInput,
  ): Promise<GitHubNotificationCommentContextResult> {
    if (input.item.itemType !== 'issue' || input.comment.disposition !== 'approved') {
      return {
        authorized: false,
        reasonCode: 'github-notification-comment-ineligible',
      };
    }
    const inspection = await this.#inspect(input);
    if (!inspection.authorized) {
      return {
        authorized: false,
        reasonCode: inspection.reasonCode ?? 'github-notification-authority-revoked',
      };
    }
    try {
      const comment = await inspection.client.getIssueComment(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
        input.comment.commentDatabaseId,
      );
      const revision = githubCommentRevision(comment);
      if (
        comment.nodeId !== input.comment.commentNodeId ||
        revision.revisionId !== input.comment.revisionId ||
        revision.bodyDigest !== input.comment.bodyDigest ||
        comment.author?.nodeId !== input.comment.actorNodeId
      ) {
        return {
          authorized: false,
          reasonCode: 'github-notification-comment-revision-stale',
        };
      }
      const admission = admitGitHubComment({
        account: inspection.client.identity,
        comment,
        configuration: inspection.configuration,
      });
      return admission.disposition === 'approved'
        ? { authorized: true, context: comment }
        : {
            authorized: false,
            reasonCode: `github-notification-${admission.code}`,
          };
    } catch (error) {
      if (
        error instanceof GitHubWorkEventClientError &&
        error.code === 'github-notification-resource-missing'
      ) {
        return { authorized: false, reasonCode: error.code };
      }
      throw error;
    }
  }

  async #inspect(
    input: GitHubNotificationAssignmentBoundaryInput,
  ): Promise<GitHubNotificationAssignmentInspection> {
    if (
      input.delivery.assignmentEventId !== input.item.assignmentEventNodeId ||
      input.delivery.workId !== `${input.item.itemType}-${input.item.itemDatabaseId}`
    ) {
      return { authorized: false, reasonCode: 'github-notification-delivery-state-invalid' };
    }
    try {
      resolveNotificationRoute(
        await this.#dependencies.readConfig(),
        { agentId: input.agentId, enabled: true, workspaceDir: input.workspaceDir },
        githubNotificationConversationId({
          itemNumber: input.item.number,
          repositoryId: input.item.repositoryNodeId,
        }),
      );
    } catch {
      return { authorized: false, reasonCode: 'github-notification-route-revoked' };
    }
    const context = await this.#connect(input);
    if (!context) {
      return { authorized: false, reasonCode: 'github-notification-configuration-revoked' };
    }
    try {
      const repository = await context.client.getRepository(
        input.item.repositoryOwner,
        input.item.repositoryName,
      );
      const permission = await context.client.getPermission(
        input.item.repositoryOwner,
        input.item.repositoryName,
        context.client.identity.login,
      );
      const item = await context.client.getItem(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
      );
      if (
        repository.databaseId !== input.item.repositoryDatabaseId ||
        repository.nodeId !== input.item.repositoryNodeId ||
        repository.owner.nodeId !== input.item.repositoryOwnerNodeId ||
        repository.cloneUrl !== input.item.repositoryCloneUrl ||
        repository.defaultBranch !== input.item.repositoryDefaultBranch ||
        item.databaseId !== input.item.itemDatabaseId ||
        item.nodeId !== input.item.itemNodeId ||
        item.itemType !== input.item.itemType ||
        item.number !== input.item.number
      ) {
        return { authorized: false, reasonCode: 'github-notification-resource-changed' };
      }
      const eventPage = await context.client.listAssignmentEvents(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
      );
      if (eventPage.truncated) {
        throw new Error('GitHub assignment history exceeded its delivery boundary.');
      }
      const admission = admitGitHubAssignment({
        account: context.client.identity,
        baselineAt: 0,
        configuration: context.configuration,
        events: eventPage.events,
        item,
        permission,
        processedEventNodeIds: new Set(),
        repository,
      });
      if (
        admission.disposition !== 'approved' ||
        admission.event?.nodeId !== input.delivery.assignmentEventId ||
        admission.event.actor.nodeId !== input.item.assignmentActorNodeId
      ) {
        return {
          authorized: false,
          reasonCode:
            admission.disposition === 'approved'
              ? 'github-notification-assignment-changed'
              : admission.code,
        };
      }
      return {
        authorized: true,
        client: context.client,
        configuration: context.configuration,
      };
    } catch (error) {
      if (
        error instanceof GitHubWorkEventClientError &&
        error.code === 'github-notification-resource-missing'
      ) {
        return { authorized: false, reasonCode: error.code };
      }
      throw error;
    }
  }

  async #connect(input: GitHubNotificationAssignmentBoundaryInput): Promise<
    | {
        client: GitHubWorkEventClient;
        configuration: GitHubNotificationsConfiguration;
      }
    | undefined
  > {
    const loaded = await this.#dependencies.manifestService.loadForAgentId(
      input.agentId,
      'service',
    );
    if (
      loaded.status !== 'loaded' ||
      loaded.manifest.agent.id !== input.agentId ||
      resolve(loaded.scope.workspaceDir) !== resolve(input.workspaceDir) ||
      !loaded.manifest.github?.notifications
    ) {
      return undefined;
    }
    const connected = await this.#dependencies.accountClient.connect(
      { manifest: loaded.manifest, workspaceDir: loaded.scope.workspaceDir },
      'service',
      input.signal,
    );
    return {
      client: new GitHubWorkEventClient(connected),
      configuration: loaded.manifest.github.notifications,
    };
  }
}
