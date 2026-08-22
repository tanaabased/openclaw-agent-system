export interface GitHubNotificationCardInput {
  emoji: string;
  mode?: string;
  note?: {
    label: string;
    text: string;
  };
  summary: string;
  title: string;
}

function oneLine(value: string, label: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized || /[\r\n\0]/u.test(value)) {
    throw new Error(`GitHub notification ${label} must contain one non-empty line.`);
  }
  return normalized;
}

/** Escape one provider-controlled value for use as Markdown text. */
export function githubNotificationMarkdownText(value: string): string {
  return value
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\\[\]`*_]/gu, '\\$&');
}

/** Render the shared title, summary, and optional mode grammar. */
export default function githubNotificationCard(input: GitHubNotificationCardInput): string {
  const card = [
    `## ${oneLine(input.emoji, 'emoji')} ${oneLine(input.title, 'title')}`,
    '',
    oneLine(input.summary, 'summary'),
  ];
  if (input.mode !== undefined) {
    card.push('', `**Mode:** ${oneLine(input.mode, 'mode')}`);
  }
  if (input.note !== undefined) {
    card.push(
      '',
      `**${oneLine(input.note.label, 'note label')}:** ${oneLine(input.note.text, 'note text')}`,
    );
  }
  return card.join('\n');
}
