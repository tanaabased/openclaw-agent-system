export type ResponseSection =
  'assessment' | 'assessment-reply' | 'work' | 'delivery' | 'delivery-reply' | 'debug';

export interface ResponseBlock {
  section: ResponseSection;
  markdown: string;
  source?: string;
}

const sections: ResponseSection[] = [
  'assessment',
  'assessment-reply',
  'work',
  'delivery',
  'delivery-reply',
  'debug',
];

/** order sections, not prose; only an explicitly identified source can replace earlier output. */
export default function composeResponseBlocks(input: readonly unknown[]): string {
  const blocks: ResponseBlock[] = [];
  for (const value of input) {
    const block = typeof value === 'string' ? { markdown: value } : value;
    if (
      !block ||
      typeof block !== 'object' ||
      !('markdown' in block) ||
      typeof block.markdown !== 'string'
    )
      continue;
    if (!block.markdown.trim()) continue;
    const section =
      'section' in block && sections.includes(block.section as ResponseSection)
        ? (block.section as ResponseSection)
        : 'work';
    const source = 'source' in block && typeof block.source === 'string' ? block.source : undefined;
    const previous = source
      ? blocks.findIndex((entry) => entry.source === source && entry.section === section)
      : -1;
    const next = { section, markdown: block.markdown, ...(source ? { source } : {}) };
    if (previous < 0) blocks.push(next);
    else blocks[previous] = next;
  }
  return sections
    .flatMap((section) =>
      blocks.filter((block) => block.section === section).map((block) => block.markdown),
    )
    .join('\n\n');
}

export function responseBlocks(
  section: ResponseSection,
  markdown: string,
  source?: string,
): ResponseBlock[] {
  return markdown.trim() ? [{ section, markdown, ...(source ? { source } : {}) }] : [];
}
