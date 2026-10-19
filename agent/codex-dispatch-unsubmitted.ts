import { nativeObject } from './automation-gateway.ts';
import creationHistory from './codex-dispatch-creation-history.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

/** prove absence of this request's native creation across complete retained history. */
export default async function unsubmittedCreation(
  request: CodexThreadRequest,
  threadId: string,
  prepared: { createdAt: number; turnId?: string; prompt?: string },
  currentTurnId: string,
): Promise<{ turnId: string } | undefined> {
  const history = await creationHistory(request, threadId, prepared, currentTurnId);
  if (!history) return;
  for (const turn of history.turns) {
    for (const item of turn.items as Record<string, unknown>[]) {
      // these native events cannot create a chat; compaction does not erase the history read above.
      if (
        [
          'userMessage',
          'agentMessage',
          'reasoning',
          'plan',
          'contextCompaction',
          'sleep',
          'webSearch',
        ].includes(String(item.type))
      )
        continue;
      if (item.type === 'commandExecution') {
        if (
          turn.id !== currentTurnId &&
          !['completed', 'failed', 'declined'].includes(String(item.status))
        )
          return;
        continue;
      }
      if (
        item.type === 'mcpToolCall' &&
        typeof item.server === 'string' &&
        typeof item.tool === 'string' &&
        ['completed', 'failed'].includes(String(item.status))
      ) {
        if (item.tool !== 'create_thread') continue;
        // compare native request arguments, never issue titles or claims in conversation prose.
        if (
          prepared.prompt &&
          nativeObject(item.arguments) &&
          typeof item.arguments.prompt === 'string' &&
          item.arguments.prompt.length > 0 &&
          item.arguments.prompt !== prepared.prompt
        )
          continue;
      }
      // matching creations (including denials), unreadable arguments and unknown events remain unresolved.
      return;
    }
  }
  return { turnId: history.turnId };
}
