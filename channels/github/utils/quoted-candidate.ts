export class GitHubNotificationQuotedCandidateError extends Error {
  override name = 'GitHubNotificationQuotedCandidateError';

  constructor(readonly code: string) {
    super('The GitHub notification response did not contain one quoted public candidate.');
  }
}

export interface GitHubNotificationMarkdownHeading {
  line: number;
  text: string;
}

/** Locate level-two headings while ignoring fenced examples. */
export function githubNotificationMarkdownHeadings(
  lines: readonly string[],
): GitHubNotificationMarkdownHeading[] {
  const result: GitHubNotificationMarkdownHeading[] = [];
  let fence: { character: '`' | '~'; length: number } | undefined;
  for (const [lineNumber, line] of lines.entries()) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (
        marker?.[0] === fence.character &&
        marker.length >= fence.length &&
        line.slice(marker.length).trim() === ''
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = { character: marker[0] as '`' | '~', length: marker.length };
      continue;
    }
    if (/^##[ \t]+\S/u.test(line)) {
      result.push({ line: lineNumber, text: line.trim() });
    }
  }
  return result;
}

/** Extract exactly one fully blockquoted section beneath an exact level-two heading. */
export default function githubNotificationQuotedCandidate(
  response: string,
  heading: string,
): string {
  const normalized = response.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  const markdownHeadings = githubNotificationMarkdownHeadings(lines);
  const matches = markdownHeadings.filter(({ text }) => text === heading);
  if (matches.length !== 1 || !matches[0]) {
    throw new GitHubNotificationQuotedCandidateError(
      'github-notification-quoted-candidate-missing',
    );
  }
  const start = matches[0].line + 1;
  const end = markdownHeadings.find(({ line }) => line >= start)?.line ?? lines.length;
  const section = lines.slice(start, end);
  while (section[0]?.trim() === '') section.shift();
  while (section.at(-1)?.trim() === '') section.pop();
  if (section.length === 0) {
    throw new GitHubNotificationQuotedCandidateError('github-notification-quoted-candidate-empty');
  }
  const content: string[] = [];
  for (const line of section) {
    if (line.trim() === '') {
      content.push('');
      continue;
    }
    const quote = /^[ \t]{0,3}>[ \t]?(.*)$/u.exec(line)?.[1];
    if (quote === undefined) {
      throw new GitHubNotificationQuotedCandidateError(
        'github-notification-quoted-candidate-invalid',
      );
    }
    content.push(quote);
  }
  const candidate = content.join('\n').trim();
  if (!candidate) {
    throw new GitHubNotificationQuotedCandidateError('github-notification-quoted-candidate-empty');
  }
  return candidate;
}
