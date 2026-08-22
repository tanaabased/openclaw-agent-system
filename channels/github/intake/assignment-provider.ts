import { resolve } from 'node:path';

import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import type { GitHubNotificationLifecycleBoundaryInput } from '../lifecycles/types.ts';
import type { GitHubNotificationAssignmentAuthority } from './assignment-orchestrator.ts';
import type GitHubAccountClient from '../../../lib/github-account-client.ts';
import type { GitHubNotificationsConfiguration } from '../config-schema.ts';
import { githubNotificationConversationId } from '../channel.ts';
import { admitGitHubAssignment } from './admit-assignment.ts';
import { resolveNotificationRoute } from '../routing/routing.ts';
import GitHubWorkEventClient, {
  GitHubWorkEventClientError,
} from '../provider/work-event-client.ts';

export interface GitHubNotificationAssignmentProviderDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

export type GitHubNotificationAssignmentInspection =
  | { authorized: false; reasonCode?: string }
  | {
      authorized: true;
      client: GitHubWorkEventClient;
      configuration: GitHubNotificationsConfiguration;
    };

/** Read current GitHub authority for assignment intake. */
export default class GitHubNotificationAssignmentProvider implements GitHubNotificationAssignmentAuthority {
  readonly #dependencies: GitHubNotificationAssignmentProviderDependencies;

  constructor(dependencies: GitHubNotificationAssignmentProviderDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(
    input: GitHubNotificationLifecycleBoundaryInput,
  ): Promise<{ authorized: boolean; reasonCode?: string }> {
    const inspection = await this.open(input);
    return inspection.authorized
      ? { authorized: true }
      : {
          authorized: false,
          ...(inspection.reasonCode === undefined ? {} : { reasonCode: inspection.reasonCode }),
        };
  }

  async open(
    input: GitHubNotificationLifecycleBoundaryInput,
  ): Promise<GitHubNotificationAssignmentInspection> {
    const lifecycleMatchesItem =
      input.item.lifecycleId === 'issue'
        ? input.item.itemType === 'issue'
        : input.item.itemType === 'pull-request';
    if (
      input.intake.assignmentEventId !== input.item.assignmentEventNodeId ||
      !lifecycleMatchesItem
    ) {
      return { authorized: false, reasonCode: 'github-notification-intake-state-invalid' };
    }
    try {
      resolveNotificationRoute(
        await this.#dependencies.readConfig(),
        { agentId: input.agentId, enabled: true, workspaceDir: input.workspaceDir },
        githubNotificationConversationId({
          itemNumber: input.item.number,
          lifecycleId: input.item.lifecycleId,
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
        item.number !== input.item.number ||
        (item.itemType === 'pull-request' &&
          (input.item.pullRequest === undefined ||
            item.pullRequest.baseRepositoryDatabaseId !== input.item.repositoryDatabaseId ||
            item.pullRequest.baseRepositoryNodeId !== input.item.repositoryNodeId ||
            item.pullRequest.baseRef !== input.item.pullRequest.baseRef ||
            item.pullRequest.headRef !== input.item.pullRequest.headRef ||
            item.pullRequest.headRepositoryDatabaseId !==
              input.item.pullRequest.headRepositoryDatabaseId ||
            item.pullRequest.headRepositoryNodeId !== input.item.pullRequest.headRepositoryNodeId ||
            item.pullRequest.author?.nodeId !== input.item.pullRequest.authorNodeId))
      ) {
        return { authorized: false, reasonCode: 'github-notification-resource-changed' };
      }
      const eventPage = await context.client.listAssignmentEvents(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
      );
      if (eventPage.truncated) {
        throw new Error('GitHub assignment history exceeded its intake boundary.');
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
        admission.event?.nodeId !== input.intake.assignmentEventId ||
        admission.event.actor.nodeId !== input.item.assignmentActorNodeId ||
        (input.item.assignmentActorLogin !== undefined &&
          admission.event.actor.login.toLowerCase() !==
            input.item.assignmentActorLogin.toLowerCase())
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

  async #connect(input: GitHubNotificationLifecycleBoundaryInput): Promise<
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
