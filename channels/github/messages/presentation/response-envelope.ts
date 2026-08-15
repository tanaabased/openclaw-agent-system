export const githubNotificationToGitHubHeading = '## 📤 To GitHub';

export const githubNotificationLegacyReplyHeading = '## 📤 Proposed GitHub reply';

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
