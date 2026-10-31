import type { AgentSystemCliResult } from './types.ts';

/** reject incomplete control data even when the retained tail happens to parse. */
export default function cliOutputComplete(
  result: Partial<
    Pick<
      AgentSystemCliResult,
      | 'timedOut'
      | 'truncated'
      | 'stdoutTruncatedBytes'
      | 'stderrTruncatedBytes'
      | 'termination'
      | 'signal'
      | 'killed'
    >
  >,
): boolean {
  return (
    !result.timedOut &&
    !result.truncated &&
    !result.killed &&
    !result.signal &&
    (!result.termination || result.termination === 'exit') &&
    !(result.stdoutTruncatedBytes && result.stdoutTruncatedBytes > 0) &&
    !(result.stderrTruncatedBytes && result.stderrTruncatedBytes > 0)
  );
}
