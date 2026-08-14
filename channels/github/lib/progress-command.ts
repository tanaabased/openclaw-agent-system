import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
} from 'openclaw/plugin-sdk/plugin-entry';

import type { Logger } from '../../../lib/logger.ts';
import githubNotificationMessage, { githubNotificationBlockquote } from '../utils/presentation.ts';
import type GitHubNotificationProgressService from './progress-service.ts';

export const githubNotificationProgressCommandName = 'agent-system-progress';

export interface GitHubNotificationProgressCommandDependencies {
  logger: Logger;
  progressService: Pick<GitHubNotificationProgressService, 'publish'>;
}

function commandError(code: string): PluginCommandResult {
  return {
    isError: true,
    text: githubNotificationMessage({
      emoji: '⚠️',
      note: { label: 'Diagnostic', text: code },
      summary: 'The selected progress update was not published to GitHub.',
      title: 'GitHub progress not published',
    }),
  };
}

function commandSuccess(text: string): PluginCommandResult {
  return {
    text: [
      githubNotificationMessage({
        emoji: '📤',
        summary: 'The selected progress update was published to GitHub.',
        title: 'GitHub progress published',
      }),
      '',
      githubNotificationBlockquote(text),
    ].join('\n'),
  };
}

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('github-notification-')
  ) {
    return error.code;
  }
  return 'github-notification-progress-publication-failed';
}

function hasOperatorWriteScope(context: PluginCommandContext): boolean {
  return (
    context.isAuthorizedSender &&
    (context.gatewayClientScopes?.includes('operator.write') === true ||
      context.gatewayClientScopes?.includes('operator.admin') === true)
  );
}

/** Register the local-only command that explicitly selects one public progress update. */
export default function registerGitHubNotificationProgressCommand(
  api: Pick<OpenClawPluginApi, 'registerCommand'>,
  dependencies: GitHubNotificationProgressCommandDependencies,
): void {
  api.registerCommand({
    acceptsArgs: true,
    description: 'Publish one selected progress update to the active GitHub issue.',
    name: githubNotificationProgressCommandName,
    requireAuth: true,
    requiredScopes: ['operator.write'],
    async handler(context) {
      if (!hasOperatorWriteScope(context)) {
        return commandError('github-notification-progress-operator-authorization-required');
      }
      if (!context.agentId || !context.sessionKey) {
        return commandError('github-notification-progress-session-required');
      }
      try {
        const text = context.args?.trim() ?? '';
        const result = await dependencies.progressService.publish({
          agentId: context.agentId,
          config: context.config,
          sessionKey: context.sessionKey,
          text,
        });
        dependencies.logger.info(
          `github-notifications: progress published agent=${context.agentId} comment=${result.commentId}`,
        );
        return commandSuccess(text);
      } catch (error) {
        const code = errorCode(error);
        dependencies.logger.warn(
          `github-notifications: progress publication failed agent=${context.agentId} code=${code}`,
        );
        return commandError(code);
      }
    },
  });
}
