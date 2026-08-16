import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import defineAgentSystemSemanticTool from '../../lib/define-agent-system-semantic-tool.ts';
import AgentSystemToolError from '../../lib/tool-error.ts';
import type { AgentManifest } from '../../utils/manifest-types.ts';
import type GitHubNotificationReplyCandidateStore from './lib/reply-candidate-store.ts';
import { githubNotificationChannelId } from './utils/routing.ts';

export const githubNotificationReplyToolName = 'agent_system_github_reply';

const githubNotificationReplyToolSchema = Type.Object(
  {
    body: Type.String({ maxLength: 800, minLength: 1 }),
  },
  { additionalProperties: false },
);

type GitHubNotificationReplyToolInput = Static<typeof githubNotificationReplyToolSchema>;

function notifications(manifest: AgentManifest) {
  return manifest.github?.notifications;
}

/** Stage one typed public candidate during a GitHub notification turn. */
export default function createGitHubNotificationReplyTool(
  candidates: GitHubNotificationReplyCandidateStore,
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
      if (
        scope.toolContext?.messageChannel !== githubNotificationChannelId ||
        !agentId ||
        !candidates.hasActive(agentId)
      ) {
        throw new AgentSystemToolError(
          'tool_unavailable',
          'The GitHub reply staging tool is available only during a GitHub notification turn.',
        );
      }
      candidates.stage(agentId, input.body.trim());
      return { status: 'staged' as const };
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
