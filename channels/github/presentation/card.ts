export const cardCopyInstructions =
  'Treat presentation as a decoded Markdown string, not its JSON serialization. Decode JSON escapes exactly once before copying it into the final response. Preserve the two trailing spaces after &nbsp; as a Markdown hard break; do not add a backslash or remove the spacer. Preserve unquoted blank lines between cards and unquoted private sections; do not wrap the whole presentation in another blockquote or code fence. Show each returned card once. Additional narration should supply only facts missing from the cards, not another paraphrase of the plan or reply. Preserve attributed incoming comments and public reply cards even when they discuss the same work. When work finishes in this turn, describe the completed outcome rather than repeating planned actions as pending.';

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

/** format a one-line literal without interpreting its markdown or embedded backticks. */
export function githubNotificationMarkdownCode(value: string): string {
  const literal = value.replace(/\s+/gu, ' ').trim();
  if (!literal) throw new Error('GitHub notification literal must not be empty.');
  const delimiter = '`'.repeat(
    (literal.match(/`+/gu) ?? []).reduce((size, run) => Math.max(size, run.length + 1), 1),
  );
  const padding = literal.startsWith('`') || literal.endsWith('`') ? ' ' : '';
  return delimiter + padding + literal + padding + delimiter;
}

export function githubNotificationQuote(text: string): string {
  return text
    .split(/\r\n|\r|\n/u)
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** present incoming prose with a plain source line and separators. */
export function githubNotificationAttributedMessage(source: string, message: string): string {
  return [source, '', '---', '', message, '', '---'].join('\n');
}

/** quote complete private cards; raw composition and public handoffs opt out explicitly. */
export default function githubNotificationCard(
  input: GitHubNotificationCardInput,
  { quoted = true }: { quoted?: boolean } = {},
): string {
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
    return quoted ? githubNotificationQuote(card.join('\n')) : card.join('\n');
  }
  card.push(oneLine(input.summary, 'summary'));
  if (input.note) {
    card.push(
      '',
      `**${oneLine(input.note.label, 'note label')}:** ${oneLine(input.note.text, 'note text')}`,
    );
  }
  return quoted ? githubNotificationQuote(card.join('\n')) : card.join('\n');
}
