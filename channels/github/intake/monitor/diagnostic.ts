import AgentSystemToolError from '../../../../api/error.ts';
import { GitHubAccountClientError } from '../../../../core/github-account-client.ts';
import { GitHubNotificationPollError } from './poller.ts';

export function githubNotificationDiagnostic(error: unknown): { code: string; retryAt?: number } {
  if (error instanceof GitHubNotificationPollError) {
    return { code: error.code, ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }) };
  }
  if (error instanceof GitHubAccountClientError) return { code: error.code };
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('github-notification-')
  ) {
    return { code: error.code };
  }
  return { code: 'github-notification-monitor-failed' };
}

export function githubNotificationToolCauseCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof AgentSystemToolError ? cause.code : undefined;
}
