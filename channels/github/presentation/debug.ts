import githubNotificationCard, { githubNotificationQuote } from './card.ts';

/** wrap private diagnostic content once, including caller-owned literal blocks. */
export default function debugCard(input: {
  debug?: boolean;
  context: string;
  facts?: readonly { label: string; value: string }[];
  detail?: string;
}): string | undefined {
  const facts = input.facts ?? [];
  if (input.debug !== true || (!facts.length && !input.detail?.trim())) return;
  const header = githubNotificationCard(
    {
      emoji: '🔬',
      title: 'Debug',
      facts: [{ label: 'Context', value: input.context }, ...facts],
    },
    { quoted: false },
  );
  return githubNotificationQuote([header, input.detail].filter(Boolean).join('\n\n'));
}
