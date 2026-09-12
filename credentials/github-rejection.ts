import type { AgentSystemCliResult } from '../api/types.ts';

/** A confirmed authentication rejection invalidates credentials; it never authorizes replay. */
export default function githubCredentialRejected(result: AgentSystemCliResult): boolean {
  return result.exitCode !== 0 && !result.timedOut && /\(HTTP 401\)/u.test(result.stderr);
}
