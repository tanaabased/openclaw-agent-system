import type { DispatchRequest } from '../../../credentials/session-dispatch.ts';
import { nativeObject } from '../../automations/automation-gateway.ts';
import { completeOpenClawMessage, openClawHistoryPages } from '../../openclaw-history.ts';
import type { DispatchCaller } from '../../openclaw-session-create.ts';
import { resultValue } from '../context/openclaw-native-material.ts';
import { taskResponse } from './task-response.ts';

export default function openClawResponse(
  request: DispatchRequest,
  caller: DispatchCaller,
  blocks: readonly unknown[] = [],
) {
  return taskResponse('openclaw', blocks, async function* () {
    const pages: Record<string, unknown>[][] = [];
    let failure = false;
    let foundRun = false;
    try {
      for await (const page of openClawHistoryPages(request, caller)) {
        pages.unshift(page);
        if (
          page.some(
            (message) =>
              nativeObject(message.__openclaw) &&
              message.__openclaw.runId === caller.runId &&
              message.role === 'user',
          )
        )
          break;
      }
    } catch {
      failure = true;
    }
    for (const partial of pages.flat()) {
      if (!nativeObject(partial.__openclaw) || partial.__openclaw.runId !== caller.runId) continue;
      foundRun = true;
      if (
        partial.role !== 'toolResult' ||
        !['agent_system_dispatch', 'tool_call'].includes(String(partial.toolName))
      )
        continue;
      try {
        const message = await completeOpenClawMessage(request, caller, partial);
        const value = resultValue(message);
        if (message.toolName === 'agent_system_dispatch') yield value;
        else if (
          nativeObject(value) &&
          nativeObject(value.tool) &&
          value.tool.source === 'openclaw' &&
          value.tool.name === 'agent_system_dispatch' &&
          nativeObject(value.result)
        )
          yield resultValue(value.result);
      } catch {
        failure = true;
      }
    }
    if (failure || !foundRun) throw new Error('response-history-incomplete');
  });
}
