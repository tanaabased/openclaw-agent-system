import type {
  AssembledInboundReply,
  PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import type { PluginHookAgentContext } from 'openclaw/plugin-sdk/types';
import type AgentManifestService from '../../../manifest/service.ts';
import type GitHubAccountClient from '../../../core/github-account-client.ts';
import type { Logger } from '../../../core/logger.ts';
import { createGitHubNotificationChannel } from '../channel.ts';
import GitHubNotificationAssignmentSessionService from '../conversation/assignment-session-service.ts';
import GitHubNotificationCommentOrchestrator from '../conversation/comment-orchestrator.ts';
import GitHubNotificationCommentTurnService from '../conversation/comment-turn-service.ts';
import GitHubNotificationConversationStateStore from '../conversation/conversation-state-store.ts';
import githubNotificationPromptGuidance from '../conversation/prompt-guidance.ts';
import GitHubNotificationTurnContractResolver from '../conversation/turn-contract.ts';
import GitHubNotificationTurnCatalog, {
  githubNotificationSupportedTurnIdentities,
} from '../conversation/turn-catalog.ts';
import GitHubNotificationTurnSelector from '../conversation/turn-selector.ts';
import githubNotificationAssignmentEvent from '../events/assignment.ts';
import githubNotificationCommentEvent from '../events/comment.ts';
import GitHubNotificationEventRegistry from '../events/registry.ts';
import GitHubNotificationAssignmentOrchestrator from '../intake/assignment-orchestrator.ts';
import GitHubNotificationAssignmentProvider from '../intake/assignment-provider.ts';
import GitHubNotificationMonitorCycleLeaseStore from '../intake/monitor/cycle-lease.ts';
import GitHubNotificationMonitorService from '../intake/monitor/service.ts';
import GitHubNotificationMonitorStateStore from '../intake/monitor/state-store.ts';
import GitHubNotificationStatusService from '../intake/monitor/status-service.ts';
import GitHubIssueLifecycle, {
  type GitHubIssueLifecycleWorktreeService,
} from '../lifecycles/issue.ts';
import GitHubPullRequestLifecycle from '../lifecycles/pull-request.ts';
import GitHubNotificationLifecycleRegistry from '../lifecycles/registry.ts';
import GitHubNotificationModeRegistry from '../modes/registry.ts';
import githubNotificationWorkMode from '../modes/work.ts';
import GitHubNotificationCommentPublicationService from '../publication/comment-publication-service.ts';
import createGitHubNotificationMessageAdapter from '../publication/message-adapter.ts';
import GitHubNotificationPublicationLeaseStore from '../publication/publication-lease.ts';
import GitHubNotificationReplyCandidateStore from '../publication/reply-candidate-store.ts';
import createGitHubNotificationReplyTool from '../publication/reply-tool.ts';
import NotificationRoutingReceiptStore from '../routing/receipt-store.ts';
import NotificationRoutingService, {
  type NotificationRoutingServiceDependencies,
} from '../routing/service.ts';
import createNotificationLifecycleContribution from './lifecycle-contribution.ts';

export interface GitHubNotificationRuntimeDependencies {
  accountClient: GitHubAccountClient;
  currentUid?: number;
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  lifecycleLogger: Logger;
  mutateConfigFile: NotificationRoutingServiceDependencies['mutateConfigFile'];
  privateStateRoot?: string;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  readRuntimeConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
  replyToolLogger: Pick<Logger, 'debug'>;
  worktrees: GitHubIssueLifecycleWorktreeService;
}

function privateStateOptions(
  dependencies: Pick<GitHubNotificationRuntimeDependencies, 'currentUid' | 'privateStateRoot'>,
) {
  return {
    ...(dependencies.currentUid === undefined ? {} : { currentUid: dependencies.currentUid }),
    ...(dependencies.privateStateRoot === undefined
      ? {}
      : { rootDir: dependencies.privateStateRoot }),
  };
}

/** Assemble the GitHub channel's stores, lifecycle contribution, tool, and runtime services. */
export default function createGitHubNotificationRuntime(
  dependencies: GitHubNotificationRuntimeDependencies,
) {
  const stateOptions = privateStateOptions(dependencies);
  const candidates = new GitHubNotificationReplyCandidateStore(stateOptions);
  const monitorStateStore = new GitHubNotificationMonitorStateStore(stateOptions);
  const monitorCycleLeaseStore = new GitHubNotificationMonitorCycleLeaseStore(stateOptions);
  const conversationStateStore = new GitHubNotificationConversationStateStore(stateOptions);
  const publicationLeaseStore = new GitHubNotificationPublicationLeaseStore(stateOptions);
  const routingService = new NotificationRoutingService({
    mutateConfigFile: dependencies.mutateConfigFile,
    readConfig: dependencies.readConfig,
    receiptStore: new NotificationRoutingReceiptStore(stateOptions),
  });
  const monitorServiceRef: { current?: GitHubNotificationMonitorService } = {};
  const lifecycleRegistry = new GitHubNotificationLifecycleRegistry([
    new GitHubIssueLifecycle(dependencies.worktrees),
    new GitHubPullRequestLifecycle(),
  ]);
  const modeRegistry = new GitHubNotificationModeRegistry([githubNotificationWorkMode]);
  const eventRegistry = new GitHubNotificationEventRegistry([
    githubNotificationAssignmentEvent,
    githubNotificationCommentEvent,
  ]);
  const turnCatalog = new GitHubNotificationTurnCatalog(githubNotificationSupportedTurnIdentities, {
    events: eventRegistry,
    lifecycles: lifecycleRegistry,
    modes: modeRegistry,
  });
  const turnSelector = new GitHubNotificationTurnSelector({
    conversations: conversationStateStore,
    logger: dependencies.lifecycleLogger,
    turns: turnCatalog,
  });
  const initialMode = modeRegistry.resolve('work');
  const turnContracts = new GitHubNotificationTurnContractResolver({ turns: turnCatalog });

  return {
    lifecycleContribution: createNotificationLifecycleContribution({
      monitorService: {
        runOnce(input) {
          const service = monitorServiceRef.current;
          if (!service) throw new Error('GitHub notification monitor service is unavailable.');
          return service.runOnce(input);
        },
      },
      routingService,
      stateStore: monitorStateStore,
    }),
    promptGuidance: {
      instructions(context: PluginHookAgentContext) {
        return githubNotificationPromptGuidance(context, {
          candidates,
          turnContracts,
          turnSelector,
        });
      },
    },
    replyTool: createGitHubNotificationReplyTool(candidates, dependencies.replyToolLogger),
    assemble(manifestService: AgentManifestService) {
      const assignmentProvider = new GitHubNotificationAssignmentProvider({
        accountClient: dependencies.accountClient,
        manifestService,
        readConfig: dependencies.readRuntimeConfig,
      });
      const assignmentSessionService = new GitHubNotificationAssignmentSessionService({
        logger: dependencies.lifecycleLogger,
        readConfig: dependencies.readRuntimeConfig,
        recordInboundSession: dependencies.recordInboundSession,
      });
      const assignmentOrchestrator = new GitHubNotificationAssignmentOrchestrator({
        authority: assignmentProvider,
        initialMode,
        lifecycles: lifecycleRegistry,
        sessions: assignmentSessionService,
        stateStore: monitorStateStore,
      });
      const commentTurnService = new GitHubNotificationCommentTurnService({
        candidates,
        dispatchReplyWithBufferedBlockDispatcher:
          dependencies.dispatchReplyWithBufferedBlockDispatcher,
        logger: dependencies.lifecycleLogger,
        readConfig: dependencies.readRuntimeConfig,
        recordInboundSession: dependencies.recordInboundSession,
        turnContracts,
      });
      const commentPublicationService = new GitHubNotificationCommentPublicationService({
        assignmentAuthority: assignmentProvider,
        conversationStateStore,
        manifestService,
        monitorStateStore,
        publicationLeaseStore,
        readConfig: dependencies.readRuntimeConfig,
      });
      const commentOrchestrator = new GitHubNotificationCommentOrchestrator({
        assignmentAuthority: assignmentProvider,
        conversationStateStore,
        initialModeId: initialMode.policy.id,
        lifecycles: lifecycleRegistry,
        logger: dependencies.lifecycleLogger,
        monitorStateStore,
        publications: commentPublicationService,
        turnCatalog,
        turns: commentTurnService,
      });
      const monitorService = new GitHubNotificationMonitorService({
        accountClient: dependencies.accountClient,
        assignmentOrchestrator,
        commentOrchestrator,
        cycleLeaseStore: monitorCycleLeaseStore,
        logger: dependencies.lifecycleLogger,
        manifestService,
        readConfig: dependencies.readRuntimeConfig,
        routingService,
        stateStore: monitorStateStore,
      });
      const statusService = new GitHubNotificationStatusService({
        monitorService,
        stateStore: monitorStateStore,
      });
      monitorServiceRef.current = monitorService;

      return {
        channel: createGitHubNotificationChannel({
          message: createGitHubNotificationMessageAdapter({
            publications: commentPublicationService,
          }),
          monitorService,
          stateStore: monitorStateStore,
        }),
        monitorService,
        statusService,
      };
    },
  };
}
