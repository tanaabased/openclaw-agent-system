import { nativeObject } from '../utils/native-object.ts';
import codexToolOutputText from './codex-tool-output-text.ts';

/** Decode native delegation output without normalizing the source or input itself. */
export default function codexDelegatedInput(
  value: unknown,
  sourceThreadId: string,
  prompt: string,
) {
  const text =
    codexToolOutputText(value) ??
    (nativeObject(value) && typeof value.text === 'string' && value.truncated !== true
      ? value.text
      : undefined);
  if (text === undefined) return false;
  const match =
    /^<codex_delegation>\s*<source_thread_id>([\s\S]*?)<\/source_thread_id>\s*<input>([\s\S]*?)<\/input>\s*<\/codex_delegation>\s*$/u.exec(
      text,
    );
  if (!match) return false;
  const unescape = (part: string) =>
    part.replace(/&(lt|gt|amp);/gu, (entity) =>
      entity === '&lt;' ? '<' : entity === '&gt;' ? '>' : '&',
    );
  return unescape(match[1]!) === sourceThreadId && unescape(match[2]!) === prompt;
}
