import type { CodexThreadRequest } from '../../codex-thread-client.ts';
import { nativeObject } from '../../../utils/native-object.ts';
import { codexRuntimeReceipt } from '../context/codex-native-material.ts';
import { nativeHistoryPages } from '../dispatch/codex-dispatch-history.ts';
import { taskResponse } from './task-response.ts';

export default function codexResponse(
  request: CodexThreadRequest,
  threadId: string,
  runtime: { entrypoint: string; pluginData: string; node: string },
  blocks: readonly unknown[] = [],
) {
  return taskResponse('codex', blocks, async function* () {
    const turns = await request('thread/turns/list', {
      threadId,
      itemsView: 'notLoaded',
      sortDirection: 'desc',
      limit: 1,
    });
    const turn = Array.isArray(turns.data) && turns.data.length === 1 && turns.data[0];
    if (
      !nativeObject(turn) ||
      typeof turn.id !== 'string' ||
      (typeof turn.completedAt === 'number' && turn.completedAt > 0)
    )
      throw new Error('response-turn-unavailable');
    for await (const entries of nativeHistoryPages(request, 'thread/items/list', {
      threadId,
      turnId: turn.id,
      sortDirection: 'asc',
    })) {
      for (const entry of entries) {
        if (entry.turnId !== turn.id || !nativeObject(entry.item))
          throw new Error('response-turn-diverged');
        const receipt = codexRuntimeReceipt(entry.item, runtime);
        if (receipt) yield receipt.value;
      }
    }
  });
}
