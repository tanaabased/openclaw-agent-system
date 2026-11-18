import { isDeepStrictEqual } from 'node:util';

import { nativeObject } from '../../../utils/native-object.ts';
import creationHistory from './codex-dispatch-creation-history.ts';
import type { CodexThreadRequest } from '../../codex-thread-client.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';

type CreationRequest = NonNullable<DispatchRecord['request']>;
type RejectedCreation = { kind: 'catalog-missing' | 'unsupported'; message: string };

function rejectedCreation(
  item: Record<string, unknown>,
  expected: CreationRequest,
): RejectedCreation | undefined {
  if (
    item.server !== 'codex_app' ||
    item.status !== 'failed' ||
    item.error != null ||
    !isDeepStrictEqual(item.arguments, expected) ||
    !nativeObject(item.result) ||
    item.result.isError === false ||
    item.result.structuredContent != null ||
    !Array.isArray(item.result.content) ||
    item.result.content.length !== 1
  )
    return;
  const part = item.result.content[0];
  if (!nativeObject(part) || part.type !== 'text' || typeof part.text !== 'string') return;
  const message = part.text;
  if (
    message ===
    `create_thread could not validate reasoning effort "${expected.thinking}" for model "${expected.model}". Use a model and reasoning combination listed in the tool description, or omit thinking.`
  )
    return { kind: 'catalog-missing', message };
  const prefix = `create_thread rejected unsupported model/reasoning combination: "${expected.model}" does not support "${expected.thinking}". `;
  if (
    message.startsWith(prefix) &&
    /^(?:This model supports no reasoning effort overrides|Supported reasoning efforts: [a-z]+(?:, [a-z]+)*)\.$/u.test(
      message.slice(prefix.length),
    )
  )
    return { kind: 'unsupported', message };
}

/** prove non-execution across native history, including exact preflight rejections on scheduled creation. */
export default async function unsubmittedNativeRequest(
  request: CodexThreadRequest,
  threadId: string,
  prepared: { createdAt?: number; turnId?: string; prompt?: string; threadId?: string },
  currentTurnId: string | undefined,
  tool: 'create_thread' | 'send_message_to_thread' = 'create_thread',
  expected?: CreationRequest,
): Promise<{ turnId: string; rejection?: RejectedCreation } | undefined> {
  const history = await creationHistory(request, threadId, prepared, currentTurnId);
  if (!history) return;
  let rejection: RejectedCreation | undefined;
  for (const turn of history.turns) {
    for (const item of turn.items as Record<string, unknown>[]) {
      // these events cannot perform the effect; compaction does not erase the history read above.
      if (
        [
          'userMessage',
          'functionCallOutput',
          'hookPrompt',
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
        if (item.tool !== tool) continue;
        if (
          tool === 'send_message_to_thread' &&
          prepared.threadId &&
          nativeObject(item.arguments) &&
          typeof item.arguments.threadId === 'string' &&
          item.arguments.threadId !== prepared.threadId
        )
          continue;
        // compare native request arguments, never issue titles or claims in conversation prose.
        if (
          tool === 'create_thread' &&
          prepared.prompt &&
          nativeObject(item.arguments) &&
          typeof item.arguments.prompt === 'string' &&
          item.arguments.prompt.length > 0 &&
          item.arguments.prompt !== prepared.prompt
        )
          continue;
        if (expected && tool === 'create_thread' && turn.id === history.turnId && !rejection) {
          rejection = rejectedCreation(item, expected);
          if (rejection) continue;
        }
      }
      // matching calls (including denials), unreadable arguments and unknown events remain unresolved.
      return;
    }
  }
  return { turnId: history.turnId, ...(rejection ? { rejection } : {}) };
}
