import type { CodexWorkContext } from './codex-continuation-context.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import codexWorkState from './codex-work-state.ts';
import implementationHandoff from './implementation-handoff.ts';
import { implementationPresentation } from './implementation-result.ts';
import nativeClarification from './native-clarification.ts';

/** Format current implementation output without persisting conversation state. */
export default function renderCodexWorkResult(
  record: DispatchRecord,
  { input }: Pick<CodexWorkContext, 'input'>,
) {
  const work = codexWorkState(record)!;
  if (!input.result) throw new Error('continuation-result-required');
  if (input.result.outcome === 'clarification-needed')
    return nativeClarification(record.id, implementationPresentation(input.result));
  return {
    status: 'native' as const,
    id: record.id,
    outcome: input.result.outcome,
    handoff: implementationHandoff(
      input.result.outcome,
      'codex',
      work.scope === 'local' ? { publication: false } : undefined,
      Boolean(record.adoptedPullRequest),
    ),
    presentation: implementationPresentation(input.result),
  };
}
