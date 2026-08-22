import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import defineAgentSystemSemanticTool from '../../../api/define-semantic-tool.ts';
import type { Logger } from '../../../core/logger.ts';
import AgentSystemToolError from '../../../api/error.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import { GitHubNotificationReplyCandidateStoreError } from './reply-candidate-store.ts';
import {
  githubNotificationReplyToolName,
  githubNotificationReplyToolOutput,
} from './reply-tool-result.ts';
import isGitHubNotificationReplyToolContext from './reply-tool-context.ts';

export { githubNotificationReplyToolName } from './reply-tool-result.ts';

const githubNotificationReplyToolSchema = Type.Object(
  {
    body: Type.String({ maxLength: 800, minLength: 1 }),
  },
  { additionalProperties: false },
);

type GitHubNotificationReplyToolInput = Static<typeof githubNotificationReplyToolSchema>;

interface GitHubNotificationReplyCandidateStager {
  stage(agentId: string, candidate: string): Promise<void>;
}

function notifications(manifest: AgentManifest) {
  return manifest.github?.notifications;
}

/** Return one typed public candidate during a GitHub notification turn. */
export default function createGitHubNotificationReplyTool(
  candidates: GitHubNotificationReplyCandidateStager,
  logger?: Pick<Logger, 'debug'>,
) {
  return defineAgentSystemSemanticTool({
    apiVersion: 1,
    authorization: {
      authorize() {
        return { status: 'allowed' };
      },
    },
    configuration: {
      read: notifications,
      resolve(configuration) {
        return configuration;
      },
    },
    commands: [],
    async execute(input: GitHubNotificationReplyToolInput, _configuration, scope) {
      if (!isGitHubNotificationReplyToolContext(scope.toolContext)) {
        throw new AgentSystemToolError(
          'tool_unavailable',
          'The GitHub reply staging tool is available only during a GitHub notification turn.',
        );
      }
      const agentId = scope.toolContext.agentId.trim();
      try {
        await candidates.stage(agentId, input.body);
      } catch (error) {
        if (error instanceof GitHubNotificationReplyCandidateStoreError) {
          throw new AgentSystemToolError(
            'tool_unavailable',
            `The GitHub reply candidate could not be staged (${error.code}).`,
          );
        }
        throw error;
      }
      return githubNotificationReplyToolOutput(input.body);
    },
    id: 'github-reply',
    tool: {
      available(context) {
        logger?.debug?.(
          [
            'github-notifications: reply tool context',
            'code=github-notification-reply-tool-context',
            `agent-id-present=${Boolean(context.agentId?.trim())}`,
            `message-channel=${context.messageChannel?.trim() || 'unset'}`,
            `delivery-channel=${context.deliveryContext?.channel?.trim() || 'unset'}`,
            `session-key-present=${Boolean(context.sessionKey?.trim())}`,
          ].join(' '),
        );
        return isGitHubNotificationReplyToolContext(context);
      },
      classify() {
        return {
          action: 'stage-github-reply',
          risk: 'write',
          summary: 'Stage one public response candidate for the current GitHub notification turn.',
        };
      },
      description:
        'Stage one concise public GitHub reply candidate for the current notification turn. This does not publish directly; Agent System validates, reauthorizes, and publishes the candidate after the private response completes.',
      inputFromCommand(argv, stdin) {
        return { body: stdin ?? argv.join(' ') };
      },
      label: 'Stage GitHub Reply',
      name: githubNotificationReplyToolName,
      parameters: githubNotificationReplyToolSchema,
      validate(input) {
        if (!Value.Check(githubNotificationReplyToolSchema, input) || !input.body.trim()) {
          throw new Error('The GitHub reply candidate is invalid.');
        }
      },
    },
  });
}
