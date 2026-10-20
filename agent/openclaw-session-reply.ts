import { sessionObject } from './openclaw-session-create.ts';

export default function issueTurnReply(messages: unknown[], runId: string) {
  return messages.map(sessionObject).findLast((entry) => {
    const metadata = entry.__openclaw;
    if (!metadata || typeof metadata !== 'object') return false;
    const meta = sessionObject(metadata);
    return (
      entry.role === 'assistant' &&
      meta.runId === runId &&
      typeof meta.id === 'string' &&
      meta.id &&
      meta.truncated !== true &&
      meta.runTerminal !== false &&
      (meta.mirrorOrigin === undefined || meta.runTerminal === true) &&
      ['stop', 'end_turn'].includes(String(entry.stopReason)) &&
      Array.isArray(entry.content) &&
      entry.content.some((block) => {
        const part = sessionObject(block);
        return (
          part.type === 'text' &&
          typeof part.text === 'string' &&
          part.text.trim() &&
          part.text.trim() !== 'NO_REPLY'
        );
      }) &&
      !entry.content.some((block) =>
        ['toolCall', 'toolUse', 'functionCall'].includes(String(sessionObject(block).type)),
      )
    );
  });
}
