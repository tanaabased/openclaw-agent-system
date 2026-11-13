import { nativeObject } from '../../automations/automation-gateway.ts';
import composeResponseBlocks from '../../../channels/github/presentation/response-blocks.ts';

export const responseInstructions =
  'For a combined task reply, use dispatch response in Codex (the supplied dispatchRuntime) or agent_system_dispatch action response in OpenClaw. Supply any additional prose as blocks of {section, markdown}; section defaults to work. Omit blocks when there is no additional text. The read-only composer gathers this turn’s existing presentation output and orders assessment, its public reply, work, delivery and debug. Preserve authored prose placement within a section; put prose around a PR in delivery blocks when needed. Reproduce its complete presentation in the final reply, without reordering or paraphrasing. Text written afterwards must remain visible as an addendum; never discard it because it was not composed. This is best-effort formatting, never a prerequisite for work or publication. If unavailable, assemble available output directly, keep all prose and exact public replies, and put debug last. Never repeat external effects to recover presentation.';

/** consume display fields only; history is never authority to perform an effect. */
export function taskResponseOutput(value: unknown): unknown[] {
  if (!nativeObject(value)) return [];
  if (value.status === 'response-composed')
    return Array.isArray(value.responseAdditions) ? value.responseAdditions : [];
  const candidates = Array.isArray(value.responseBlocks) ? value.responseBlocks : [];
  const available = candidates.filter(
    (block) =>
      typeof block === 'string' || (nativeObject(block) && typeof block.markdown === 'string'),
  );
  const malformed =
    value.responseBlocks !== undefined &&
    (!Array.isArray(value.responseBlocks) || available.length !== candidates.length);
  const fallback =
    typeof value.presentation === 'string' && value.presentation.trim()
      ? [{ section: 'work', markdown: value.presentation }]
      : [];
  // retain readable fragments even when their siblings are malformed; never inspect headings.
  const blocks: unknown[] = available.length ? [...available] : fallback;
  if (malformed)
    blocks.push({
      section: 'work',
      markdown:
        'Some presentation blocks were unavailable. Available text is preserved; underlying work is unchanged.',
    });
  for (const notice of [value.notice, ...(Array.isArray(value.notices) ? value.notices : [])]) {
    if (!nativeObject(notice) || typeof notice.message !== 'string') continue;
    if (
      blocks.some(
        (block) =>
          nativeObject(block) &&
          typeof block.markdown === 'string' &&
          block.markdown.includes(notice.message as string),
      )
    )
      continue;
    const affected = blocks.findLast((block) => nativeObject(block) && block.section !== 'debug');
    blocks.push({
      section: nativeObject(affected) ? affected.section : 'work',
      markdown: notice.message,
    });
  }
  return blocks;
}

export async function taskResponse(
  runtime: 'codex' | 'openclaw',
  authored: readonly unknown[],
  history?: () => AsyncIterable<unknown>,
  render = composeResponseBlocks,
) {
  const blocks: unknown[] = [];
  let incomplete = !history;
  try {
    if (history) for await (const output of history()) blocks.push(...taskResponseOutput(output));
  } catch {
    incomplete = true;
  }
  blocks.push(...authored);
  let presentation: string;
  try {
    presentation = render(blocks);
  } catch {
    incomplete = true;
    presentation = composeResponseBlocks(blocks);
  }
  if (incomplete)
    presentation +=
      '\n\nPresentation history or formatting was incomplete; available output is preserved. Underlying work is unchanged.';
  return {
    runtime,
    status: 'response-composed' as const,
    presentation,
    incomplete,
    responseAdditions: authored,
    instructions:
      'Show this complete Markdown in the final reply. Preserve additional text written afterwards as an addendum. This read-only result does not establish visible delivery or authorize any effect. Missing output may be supplied directly from native conversation; never repeat work or publication for formatting.',
  };
}
