import { nativeObject } from './automation-gateway.ts';
import {
  completeOpenClawMessage,
  openClawHistoryPages,
  type HistoryScope,
} from './openclaw-history.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import { bindNativeMaterial } from './native-material.ts';

export async function* openClawMaterialReceipts(
  request: DispatchRequest,
  scope: HistoryScope,
  tool: string,
) {
  for await (const page of openClawHistoryPages(request, scope)) {
    for (const partial of [...page].reverse()) {
      if (partial.role !== 'toolResult' || partial.toolName !== tool || partial.isError === true)
        continue;
      const message = await completeOpenClawMessage(request, scope, partial);
      if (message.toolName !== tool || message.isError === true)
        throw new Error('material-native-history-invalid');
      if (nativeObject(message.details)) {
        yield message.details;
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      const text = message.content
        .filter(nativeObject)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
      try {
        yield JSON.parse(text);
      } catch {
        /* Incomplete output is not a version receipt. */
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
  return bindNativeMaterial(tool, input, openClawMaterialReceipts(request, scope, tool));
}
