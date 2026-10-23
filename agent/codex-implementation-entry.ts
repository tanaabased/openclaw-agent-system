import { implementationReadback } from './implementation-result.ts';
import { parseDirectImplementationRequest } from '../tools/dispatch/implementation-schema.ts';
import codexEntryContext from './codex-entry-context.ts';
import type { CodexFeedbackDependencies } from './codex-feedback.ts';
import implementationEntry from './implementation-entry.ts';

export default function codexImplementationEntry(
  pluginData: string,
  input: unknown,
  deps: CodexFeedbackDependencies,
) {
  const action = parseDirectImplementationRequest(input);
  return codexEntryContext(
    pluginData,
    action,
    deps,
    (context) => implementationEntry(action, context),
    async (owner, result) =>
      action.operation === 'present'
        ? implementationReadback(owner.id, result)
        : {
            status: 'managed' as const,
            owner,
            runtime: 'codex' as const,
            instruction: 'Resume the existing native implementation owner and exact receipts.',
          },
  );
}
