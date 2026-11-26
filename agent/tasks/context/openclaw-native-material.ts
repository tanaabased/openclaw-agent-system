import { nativeObject } from '../../../utils/native-object.ts';
import {
  completeOpenClawMessage,
  openClawHistoryPages,
  type HistoryScope,
} from '../../openclaw-history.ts';
import type { DispatchRequest } from '../../../credentials/session-dispatch.ts';
import { bindNativeMaterial } from './native-material.ts';

function hasReceiptFields(value: unknown): boolean {
  return nativeObject(value) && Array.isArray(value.path) && typeof value.digest === 'string';
}

function hasMaterialReceipt(value: Record<string, unknown>): boolean {
  return (
    (typeof value.materialScope === 'string' && hasReceiptFields(value.materialPage)) ||
    (nativeObject(value.contextMaterials) &&
      Array.isArray(value.contextMaterials.fields) &&
      value.contextMaterials.fields.some(
        (field: unknown) =>
          nativeObject(field) && typeof field.materialScope === 'string' && hasReceiptFields(field),
      ))
  );
}

function hasWrappedResult(value: Record<string, unknown>) {
  return nativeObject(value.tool) && nativeObject(value.result);
}

export function resultValue(
  result: Record<string, unknown>,
  useDetails: (details: Record<string, unknown>) => boolean = () => true,
): unknown {
  if (nativeObject(result.details) && useDetails(result.details)) return result.details;
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content
    .filter(nativeObject)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // Incomplete output is not a version receipt.
  }
}

export async function* openClawMaterialReceipts(
  request: DispatchRequest,
  scope: HistoryScope,
  tool: string,
  aliases: string[] = [],
) {
  for await (const page of openClawHistoryPages(request, scope)) {
    for (const partial of [...page].reverse()) {
      if (
        partial.role !== 'toolResult' ||
        ![tool, ...aliases, 'tool_call', 'dispatch_action'].includes(String(partial.toolName)) ||
        partial.isError === true
      )
        continue;
      const message = await completeOpenClawMessage(request, scope, partial);
      if (message.toolName !== partial.toolName || message.isError === true)
        throw new Error('material-native-history-invalid');
      if ([tool, ...aliases].includes(String(message.toolName))) {
        yield resultValue(message, hasMaterialReceipt);
        continue;
      }
      const value = resultValue(message, hasWrappedResult);
      if (
        nativeObject(value) &&
        nativeObject(value.tool) &&
        value.tool.source === 'openclaw' &&
        [tool, ...aliases].includes(String(value.tool.name)) &&
        nativeObject(value.result) &&
        value.result.isError !== true
      ) {
        yield resultValue(value.result, hasMaterialReceipt);
      }
    }
  }
}

export default function openClawNativeMaterial(
  request: DispatchRequest,
  scope: HistoryScope,
  tool: string,
  input: Record<string, unknown>,
) {
  return bindNativeMaterial(
    tool,
    input,
    openClawMaterialReceipts(
      request,
      scope,
      tool,
      tool === 'agent_system_dispatch' && input.action === 'context'
        ? ['agent_system_context']
        : [],
    ),
  );
}
