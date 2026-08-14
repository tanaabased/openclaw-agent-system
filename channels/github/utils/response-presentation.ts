export type GitHubNotificationPublicCandidateLabel = 'ACKNOWLEDGMENT' | 'GITHUB_REPLY';

export interface GitHubNotificationMarkdownLine {
  line: number;
  text: string;
}

export interface GitHubNotificationMarkdownResponse {
  lines: string[];
  visibleLines: GitHubNotificationMarkdownLine[];
}

export interface GitHubNotificationPublicCandidate extends GitHubNotificationMarkdownLine {
  format: 'legacy' | 'markdown';
  value: string;
}

/** Expose only lines outside fenced code while retaining their original positions. */
export function githubNotificationMarkdownResponse(
  response: string,
): GitHubNotificationMarkdownResponse {
  const lines = response.replace(/\r\n?/gu, '\n').split('\n');
  const visibleLines: GitHubNotificationMarkdownLine[] = [];
  let fence: { character: '`' | '~'; length: number } | undefined;

  for (const [line, text] of lines.entries()) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(text)?.[1];
    if (fence) {
      if (
        marker?.[0] === fence.character &&
        marker.length >= fence.length &&
        text.slice(marker.length).trim() === ''
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = { character: marker[0] as '`' | '~', length: marker.length };
      continue;
    }
    visibleLines.push({ line, text });
  }

  return { lines, visibleLines };
}

/** Find explicit public candidates without accepting candidate-shaped fenced examples. */
export function githubNotificationPublicCandidates(
  response: string,
  label: GitHubNotificationPublicCandidateLabel,
): GitHubNotificationPublicCandidate[] {
  const escapedLabel = label === 'ACKNOWLEDGMENT' ? 'ACKNOWLEDGMENT' : 'GITHUB_REPLY';
  const markdown = new RegExp(`^>[ \\t]+${escapedLabel}:[ \\t]*(\\S.+?)[ \\t]*$`, 'u');
  const legacy = new RegExp(`^${escapedLabel}:[ \\t]*(\\S.+?)[ \\t]*$`, 'u');

  const candidates: GitHubNotificationPublicCandidate[] = [];
  for (const { line, text } of githubNotificationMarkdownResponse(response).visibleLines) {
    const markdownMatch = markdown.exec(text)?.[1];
    if (markdownMatch) {
      candidates.push({ format: 'markdown', line, text, value: markdownMatch });
      continue;
    }
    const legacyMatch = legacy.exec(text)?.[1];
    if (legacyMatch) candidates.push({ format: 'legacy', line, text, value: legacyMatch });
  }
  return candidates;
}
