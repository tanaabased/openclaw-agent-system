import { resolve } from 'node:path';

import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import type {
  GitHubNotificationAssignmentAuthority,
  GitHubNotificationAssignmentBoundaryInput,
} from '../../../lib/github-notification-assignment-orchestrator.ts';
import type GitHubAccountClient from '../../../lib/github-account-client.ts';
import type { GitHubNotificationsConfiguration } from '../config-schema.ts';
import { githubNotificationConversationId } from '../channel.ts';
import { admitGitHubAssignment } from '../utils/admit-assignment.ts';
import type { GitHubNotificationBriefingData } from '../utils/briefing.ts';
import { resolveNotificationRoute } from '../utils/routing.ts';
import GitHubWorkEventClient, { GitHubWorkEventClientError } from './work-event-client.ts';

export interface GitHubNotificationAssignmentProviderDependencies {
  accountClient: Pick<GitHubAccountClient, 'connect'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

/** Read current GitHub authority and transient briefing data for assignment delivery. */
export default class GitHubNotificationAssignmentProvider implements GitHubNotificationAssignmentAuthority {
  readonly #dependencies: GitHubNotificationAssignmentProviderDependencies;

  constructor(dependencies: GitHubNotificationAssignmentProviderDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(
    input: GitHubNotificationAssignmentBoundaryInput,
  ): Promise<{ authorized: boolean; reasonCode?: string }> {
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
      return { authorized: true };
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

  async briefing(
    input: GitHubNotificationAssignmentBoundaryInput,
  ): Promise<GitHubNotificationBriefingData> {
    const context = await this.#connect(input);
    if (!context) throw new Error('GitHub notification configuration is no longer available.');
    const [projection, eventPage] = await Promise.all([
      context.client.getBriefing(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
      ),
      context.client.listAssignmentEvents(
        input.item.repositoryOwner,
        input.item.repositoryName,
        input.item.number,
      ),
    ]);
    if (eventPage.truncated) {
      throw new Error('GitHub assignment history exceeded its briefing boundary.');
    }
    const assignment = eventPage.events.find(
      (event) =>
        event.event === 'assigned' &&
        event.nodeId === input.delivery.assignmentEventId &&
        event.actor.nodeId === input.item.assignmentActorNodeId &&
        event.assignee.nodeId === context.client.identity.nodeId,
    );
    if (!assignment)
      throw new Error('The admitted GitHub assignment event is no longer available.');
    return {
      assignmentActor: assignment.actor,
      assignmentAt: assignment.createdAt,
      projection,
    };
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
