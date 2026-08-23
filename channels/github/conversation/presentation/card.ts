interface GitHubNotificationCardBaseInput {
  emoji: string;
  title: string;
}

export type GitHubNotificationCardInput = GitHubNotificationCardBaseInput &
  (
    | {
        facts: readonly {
          label: string;
          value: string;
        }[];
      }
    | {
        note?: {
          label: string;
          text: string;
        };
        summary: string;
      }
  );

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

/** Render the shared title and compact fact-list grammar. */
export default function githubNotificationCard(input: GitHubNotificationCardInput): string {
  const card = [`## ${oneLine(input.emoji, 'emoji')} ${oneLine(input.title, 'title')}`, ''];
  if ('facts' in input) {
    if (input.facts.length === 0) {
      throw new Error('GitHub notification cards must contain at least one fact.');
    }
    card.push(
      ...input.facts.map(
        ({ label, value }) =>
          `- **${oneLine(label, 'fact label')}:** ${oneLine(value, 'fact value')}`,
      ),
    );
    return card.join('\n');
  }
  card.push(oneLine(input.summary, 'summary'));
  if (input.note) {
    card.push(
      '',
      `**${oneLine(input.note.label, 'note label')}:** ${oneLine(input.note.text, 'note text')}`,
    );
  }
  return card.join('\n');
}
