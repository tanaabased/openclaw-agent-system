import {
  createGitHubNotificationMonitorState,
  type GitHubNotificationMonitorState,
} from './state.ts';

const maximumFailureBackoffMs = 60 * 60 * 1000;

export interface GitHubNotificationFailureStateInput {
  agentId: string;
  code: string;
  current: GitHubNotificationMonitorState | undefined;
  now: number;
  random: () => number;
  retryAt?: number;
  workspaceDir: string;
}

/** Project one monitor failure into a new deterministic backoff state. */
export default function createGitHubNotificationFailureState(
  input: GitHubNotificationFailureStateInput,
): GitHubNotificationMonitorState {
  const state = input.current
    ? structuredClone(input.current)
    : createGitHubNotificationMonitorState(input.agentId, input.workspaceDir);
  state.diagnosticCode = input.code;
  state.failureCount += 1;
  state.lastPollAt = input.now;
  const exponential = Math.min(
    maximumFailureBackoffMs,
    30_000 * 2 ** Math.min(state.failureCount - 1, 7),
  );
  const jitter = 0.9 + input.random() * 0.2;
  state.nextPollAt = Math.max(input.now + Math.floor(exponential * jitter), input.retryAt ?? 0);
  return state;
}
