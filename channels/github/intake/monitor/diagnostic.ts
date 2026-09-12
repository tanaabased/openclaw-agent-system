import AgentSystemToolError from '../../../../api/error.ts';
import { GitHubAccountClientError } from '../../../../core/github-account-client.ts';
import { GitHubNotificationPollError } from './poller.ts';

const safeLlmCauseCodes = new Set([
  'LLM_COMPLETION_ABORTED',
  'LLM_COMPLETION_FAILED',
  'LLM_COMPLETION_NOT_AUTHORIZED',
  'LLM_COMPLETION_OUTPUT_REJECTED',
  'LLM_COMPLETION_TIMEOUT',
  'LLM_ISOLATED_INPUT_REJECTED',
  'LLM_ISOLATED_UNSUPPORTED',
  'LLM_RUNTIME_UNAVAILABLE',
]);

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
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
    if (cause instanceof AgentSystemToolError) return cause.code;
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
    if (code && safeLlmCauseCodes.has(code)) return code;
    cause = cause.cause;
  }
  return undefined;
}
