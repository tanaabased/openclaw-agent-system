import { resolve } from 'node:path';

import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { legacyGitHubNotifications } from '../config-schema.ts';
import defineAgentSystemSemanticTool from '../../../api/define-semantic-tool.ts';
import AgentSystemToolError, { type AgentSystemToolFailureDiagnostic } from '../../../api/error.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import { githubNotificationConversationId } from '../channel.ts';
import type GitHubNotificationConversationStateStore from '../conversation/conversation-state-store.ts';
import {
  GitHubIssueDeliveryError,
  type default as GitHubNotificationIssueDeliveryService,
} from '../conversation/issue-delivery-service.ts';
import {
  GitHubNotificationPullRequestHandoffError,
  type default as GitHubNotificationPullRequestHandoffService,
} from '../conversation/pull-request-handoff-service.ts';
import type { GitHubNotificationAssignmentProviderAuthority } from '../intake/assignment-provider.ts';
import type GitHubNotificationMonitorStateStore from '../intake/monitor/state-store.ts';
import { githubNotificationChannelId } from '../routing/routing.ts';

const parameters = Type.Object(
  {
    body: Type.Optional(Type.String({ maxLength: 65_536 })),
    title: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
  },
  { additionalProperties: false },
);
type Input = Static<typeof parameters>;

interface TaskPullRequestServices {
  authority: GitHubNotificationAssignmentProviderAuthority;
  delivery: Pick<GitHubNotificationIssueDeliveryService, 'publishTaskPullRequest'>;
  handoff: Pick<GitHubNotificationPullRequestHandoffService, 'checkpointTask'>;
}

interface Dependencies {
  conversations: Pick<GitHubNotificationConversationStateStore, 'readRouted'>;
  monitor: Pick<GitHubNotificationMonitorStateStore, 'read'>;
  services(): TaskPullRequestServices | undefined;
}

function issueSession(context: OpenClawPluginToolContext | undefined) {
  const agentId = context?.agentId?.trim().toLowerCase();
  const parsed = context?.sessionKey ? parseAgentSessionKey(context.sessionKey) : null;
  if (!agentId || !parsed || parsed.agentId.toLowerCase() !== agentId) return undefined;
  const segments = parsed.rest.split(':');
  const [channel, accountId, kind, provider, itemType, repositoryId, number] = segments;
  if (
    segments.length !== 7 ||
    channel !== githubNotificationChannelId ||
    accountId !== agentId ||
    kind !== 'direct' ||
    provider !== 'github' ||
    itemType !== 'issue' ||
    !repositoryId ||
    !/^[1-9]\d*$/u.test(number ?? '')
  )
    return undefined;
  try {
    const itemNumber = Number(number);
    if (!Number.isSafeInteger(itemNumber)) return undefined;
    return { agentId, number: itemNumber, repositoryId: decodeURIComponent(repositoryId) };
  } catch {
    return undefined;
  }
}

function unavailable(): never {
  throw new AgentSystemToolError(
    'tool_unavailable',
    'Task PR publication requires a current, prepared GitHub issue-owned session.',
  );
}

function handoffFailure(
  stage: AgentSystemToolFailureDiagnostic['stage'],
  category: AgentSystemToolFailureDiagnostic['category'],
  completed?: { number: number; reasonCode?: string },
): AgentSystemToolError {
  const guidance =
    stage === 'publication'
      ? category === 'invalid-response'
        ? 'GitHub returned unexpected data. Inspect the Gateway audit and response contract before retrying.'
        : category === 'identity-mismatch'
          ? 'Do not reuse this PR; verify its author and the managed branch.'
          : 'Inspect GitHub access, the managed branch, and existing PR before retrying; publication may have partially completed.'
      : stage === 'checkpoint'
        ? 'The PR may already exist. Check the issue-session link before retrying.'
        : 'Check that the issue assignment is still authorized before retrying.';
  return new AgentSystemToolError(
    'execution_failed',
    `Task PR handoff failed at ${stage} (${category}). ${completed ? `PR #${completed.number} publication is complete. ${completed.reasonCode ? `Reason: ${completed.reasonCode}. ` : ''}` : ''}${guidance}`,
    false,
    undefined,
    {
      stage,
      category,
      ...(completed
        ? {
            publication: { status: 'published', number: completed.number },
            ...(completed.reasonCode ? { reasonCode: completed.reasonCode } : {}),
          }
        : {}),
    },
  );
}

/** Publish an issue task PR through the same creation and recipient owner as Work delivery. */
export default function createGitHubNotificationTaskPullRequestTool(dependencies: Dependencies) {
  return defineAgentSystemSemanticTool({
    apiVersion: 1,
    authorization: { authorize: () => ({ status: 'allowed' }) },
    commands: [],
    configuration: {
      read(manifest: AgentManifest) {
        return legacyGitHubNotifications(manifest.github?.notifications);
      },
      resolve(configuration) {
        return configuration;
      },
    },
    async execute(input: Input, _configuration, scope) {
      const route = issueSession(scope.toolContext);
      if (!route || route.agentId !== scope.agentId) unavailable();
      const snapshot = await dependencies.conversations.readRouted(
        scope.agentId,
        githubNotificationConversationId({
          itemNumber: route.number,
          lifecycleId: 'issue',
          repositoryId: route.repositoryId,
        }),
      );
      const monitor = await dependencies.monitor.read(scope.agentId);
      const conversation = snapshot?.conversation;
      const item = conversation?.itemKey ? monitor?.items[conversation.itemKey] : undefined;
      if (
        !snapshot ||
        resolve(snapshot.workspaceDir) !== resolve(scope.workspaceDir) ||
        !conversation ||
        !item ||
        item.number !== route.number ||
        item.repositoryNodeId.toLowerCase() !== route.repositoryId.toLowerCase() ||
        item.lifecycleId !== 'issue' ||
        item.itemType !== 'issue' ||
        item.disposition !== 'approved' ||
        item.intake?.stage !== 'prepared' ||
        !item.intake.worktreePath ||
        !item.intake.worktreeBranch ||
        !conversation.assignmentResponse ||
        (conversation.activeTurn &&
          conversation.activeTurn.eventId !== 'comment' &&
          !(
            conversation.activeTurn.eventId === 'pull-request-opened' &&
            conversation.activeTurn.sourceId === conversation.deliveryPullRequest?.nodeId &&
            conversation.deliveryPullRequest.status === 'open' &&
            conversation.implementation?.status === 'completed'
          ))
      )
        unavailable();
      const services = dependencies.services();
      if (!services) unavailable();
      const authorityInput = {
        agentId: scope.agentId,
        intake: item.intake,
        item,
        workspaceDir: scope.workspaceDir,
        ...(scope.signal === undefined ? {} : { signal: scope.signal }),
      };
      let opened;
      try {
        opened = await services.authority.open(authorityInput);
      } catch {
        throw handoffFailure('authorization', 'state-or-configuration');
      }
      if (!opened.authorized) throw handoffFailure('authorization', 'authority-revoked');
      let pullRequest;
      try {
        pullRequest = await services.delivery.publishTaskPullRequest({
          agentId: scope.agentId,
          item,
          workspaceDir: scope.workspaceDir,
          worktree: { branch: item.intake.worktreeBranch, path: item.intake.worktreePath },
          ...(conversation.deliveryPullRequest
            ? {
                expectedPullRequest: {
                  pullRequestNodeId: conversation.deliveryPullRequest.nodeId,
                  pullRequestNumber: conversation.deliveryPullRequest.number,
                },
              }
            : {}),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(scope.signal === undefined ? {} : { signal: scope.signal }),
        });
      } catch (error) {
        throw handoffFailure(
          'publication',
          error instanceof GitHubIssueDeliveryError ? error.category : 'state-or-configuration',
        );
      }
      const completedPublication = { number: pullRequest.pullRequestNumber };
      let refreshed;
      try {
        refreshed = await services.authority.open(authorityInput);
      } catch {
        throw handoffFailure('authorization', 'state-or-configuration', completedPublication);
      }
      if (!refreshed.authorized) {
        throw handoffFailure('authorization', 'authority-revoked', completedPublication);
      }
      let handoffStatus;
      try {
        handoffStatus = await services.handoff.checkpointTask({
          agentId: scope.agentId,
          item,
          pullRequest,
          workspaceDir: scope.workspaceDir,
          ...(scope.signal === undefined ? {} : { signal: scope.signal }),
        });
      } catch (error) {
        throw handoffFailure('checkpoint', 'checkpoint-failed', {
          number: pullRequest.pullRequestNumber,
          reasonCode:
            error instanceof GitHubNotificationPullRequestHandoffError &&
            /^github-notification-pull-request-handoff-(session-ineligible|identity-mismatch|work-owned|source-failed)$/u.test(
              error.code,
            )
              ? error.code
              : 'github-notification-pull-request-handoff-checkpoint-unknown',
        });
      }
      return {
        handoffStatus,
        number: pullRequest.pullRequestNumber,
        status: 'linked',
      };
    },
    id: 'github-task-pr',
    tool: {
      available: (context) => Boolean(issueSession(context)),
      classify: () => ({
        action: 'publish-task-pr',
        risk: 'write',
        summary: 'Create or link the current issue task pull request and reconcile recipients.',
      }),
      description:
        'Create or link the current GitHub issue task PR on its managed branch. Applies configured assignees and reviewers and records the PR for issue-owned comment intake. Returns a handoff status snapshot; normal notification reconciliation completes the card and issue comment. Use instead of gh pr create for this task; never merges.',
      inputFromCommand: () => ({}),
      label: 'Publish Task PR',
      name: 'agent_system_github_task_pr',
      parameters,
      validate(input) {
        if (
          !Value.Check(parameters, input) ||
          (input.title !== undefined && !input.title.trim()) ||
          (input.body !== undefined && input.body.includes('\0'))
        )
          throw new Error('The task pull request request is invalid.');
      },
    },
  });
}
