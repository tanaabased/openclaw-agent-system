import { implementationReadback } from './implementation-result.ts';
import { parseDirectImplementationRequest } from '../tools/dispatch/implementation-schema.ts';
import implementationEntry from './implementation-entry.ts';
import openClawEntryContext from './openclaw-entry-context.ts';

export default function openClawImplementationEntry(
  input: Parameters<typeof openClawEntryContext>[0],
) {
  const action = parseDirectImplementationRequest(input.action);
  return openClawEntryContext(
    { ...input, action },
    (deps) => implementationEntry(action, deps),
    async (owner, result) =>
      action.operation === 'present'
        ? implementationReadback(owner.id, result)
        : {
            status: 'managed' as const,
            owner,
            runtime: 'openclaw' as const,
            instruction:
              'Resume the existing native implementation owner and exact source receipts.',
          },
  );
}
