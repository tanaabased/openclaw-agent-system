import { codexDispatchNative } from './codex-dispatch-native.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import { selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { managedIssueState } from './managed-issue.ts';
import {
  nativeDispatchDigest,
  nativeDispatchSelection,
  nativeDispatchResponse,
} from './native-dispatch-selection.ts';
import { assertNativeContextInput } from './native-context-request.ts';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';
import { Value } from 'typebox/value';
import nativeOperatorSelection from './native-operator-selection.ts';
import nativeFeedbackReconciliation from './native-feedback-reconciliation.ts';

/** Read existing custody; the dispatch owner still verifies activation and the live occurrence. */
export default async function codexDispatchBinding(
  pluginData: string,
  input: Record<string, unknown>,
  threadId: string,
) {
  assertNativeContextInput(input);
  if (!Value.Check(dispatchModelParameters, input))
    throw new Error('dispatch-model-request-invalid');
  if (input.action === 'retire' && input.native)
    return { action: 'retire', native: input.native, apply: !input.preview };
  const current = await selectCodexIntake(
    pluginData,
    {},
    { resolvePolicy: false, inspectionOnly: true },
  );
  if (input.action === 'report') {
    if (Object.keys(input).some((key) => key !== 'action'))
      throw new Error('native-context-binding-override');
    const connection = await connectCodexThreads(current.workspace, current.codexHome);
    try {
      const occurrence = await codexDispatchNative(connection.request).occurrence(threadId);
      return {
        action: 'report',
        automationId: occurrence.automationId,
        currentTimeIso: occurrence.currentTimeIso,
      };
    } finally {
      await connection.close();
    }
  }
  const journal = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const state = await journal.read();
  const admitted = managedIssueState(await current.store.read(), state.records);
  const record =
    input.action === 'retire'
      ? nativeOperatorSelection(input, state.records, admitted?.records ?? [], threadId)
      : nativeDispatchSelection(input, state.records, admitted?.records ?? [], threadId);
  const authored: Record<string, unknown> = { ...input };
  delete authored.target;
  delete authored.preview;
  return {
    ...authored,
    id: record.id,
    ...(input.action === 'retire' ? { apply: !input.preview } : {}),
    ...(input.action === 'prepare' ? { digest: nativeDispatchDigest(record, 'codex') } : {}),
  };
}

export async function codexDispatchResponse<T>(pluginData: string, value: T): Promise<T> {
  if (!value || typeof value !== 'object' || !('id' in value)) return value;
  const current = await selectCodexIntake(
    pluginData,
    {},
    { resolvePolicy: false, inspectionOnly: true },
  );
  const journal = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const state = await journal.read();
  return nativeDispatchResponse(value, state.records, (await current.store.read())?.records ?? []);
}

export async function codexFeedbackReconciliation(
  pluginData: string,
  input: Record<string, unknown>,
  threadId: string,
) {
  assertNativeContextInput(input);
  if (Object.keys(input).some((key) => !['action', 'source'].includes(key)))
    throw new Error('feedback-request-invalid');
  const current = await selectCodexIntake(
    pluginData,
    {},
    { resolvePolicy: false, inspectionOnly: true },
  );
  const journal = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const state = await journal.read();
  return {
    action: 'reconcile',
    ...nativeFeedbackReconciliation(
      state.records,
      (await current.store.read())?.records ?? [],
      threadId,
      input.source,
    ),
  };
}
