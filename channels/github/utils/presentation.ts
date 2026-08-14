export interface GitHubNotificationMessageInput {
  emoji: string;
  note?: {
    label: string;
    text: string;
  };
  summary: string;
  title: string;
}

export const githubNotificationProposedReplyHeading = '## 📤 Proposed GitHub reply';

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

/** Render one complete value as a Markdown blockquote. */
export function githubNotificationBlockquote(value: string): string {
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (!normalized || normalized.includes('\0')) {
    throw new Error('GitHub notification blockquotes must not be empty.');
  }
  return normalized
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** Render the shared rich heading, summary, and optional-note grammar. */
export default function githubNotificationMessage(input: GitHubNotificationMessageInput): string {
  const emoji = oneLine(input.emoji, 'emoji');
  const title = oneLine(input.title, 'title');
  const summary = oneLine(input.summary, 'summary');
  const note =
    input.note === undefined
      ? []
      : [
          '',
          `**${oneLine(input.note.label, 'note label')}:** ${oneLine(
            input.note.text,
            'note text',
          )}`,
        ];
  return [`## ${emoji} ${title}`, '', summary, ...note].join('\n');
}
