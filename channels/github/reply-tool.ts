import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import defineAgentSystemSemanticTool from '../../lib/define-agent-system-semantic-tool.ts';
import AgentSystemToolError from '../../lib/tool-error.ts';
import type { AgentManifest } from '../../utils/manifest-types.ts';
import { GitHubNotificationReplyCandidateStoreError } from './lib/reply-candidate-store.ts';
import {
  githubNotificationReplyToolName,
  githubNotificationReplyToolOutput,
} from './utils/reply-tool-result.ts';
import { githubNotificationChannelId } from './utils/routing.ts';

export { githubNotificationReplyToolName } from './utils/reply-tool-result.ts';

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
      const agentId = scope.toolContext?.agentId?.trim();
      if (scope.toolContext?.messageChannel !== githubNotificationChannelId || !agentId) {
        throw new AgentSystemToolError(
          'tool_unavailable',
          'The GitHub reply staging tool is available only during a GitHub notification turn.',
        );
      }
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
        return (
          context.messageChannel === githubNotificationChannelId && Boolean(context.agentId?.trim())
        );
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
