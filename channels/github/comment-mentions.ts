import { fromMarkdown } from 'mdast-util-from-markdown';

type MarkdownNode =
  ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

export interface GitHubCommentMention {
  end: number;
  start: number;
}

function maskPattern(value: string, pattern: RegExp): string {
  return value.replace(pattern, (match) =>
    match.replace(/[^\r\n]/gu, (character: string) => ' '.repeat(character.length)),
  );
}

export function githubCommentProseMentions(body: string, login: string): GitHubCommentMention[] {
  if (!body.includes('@')) return [];
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_@/\\\\.+-])(@${escaped})(?![\\p{L}\\p{N}_@/-]|\\.[\\p{L}\\p{N}])`,
    'giu',
  );
  let prose = maskPattern(body, /<(blockquote|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/giu);
  prose = maskPattern(prose, /<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$/giu);
  prose = maskPattern(prose, /<!--[\s\S]*?(?:-->|$)/gu);
  const literals = [
    ...prose.matchAll(
      /\b(?:[a-z][a-z\d+.-]*:|www\.)[^\s<>]+|"[^"\r\n]+"@[a-z\d.-]+|[\p{L}\p{N}_][\p{L}\p{N}_.!#$%&'*+/=?^`{|}~-]*@[a-z\d.-]+/giu,
    ),
  ];
  const mentions: GitHubCommentMention[] = [];
  function visit(node: MarkdownNode): void {
    if (node.type === 'text') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const raw = maskPattern(prose.slice(start, end), /\\[\\`*{}[\]()#+\-.!_>@]/gu);
      for (const match of raw.matchAll(pattern)) {
        const offset = start + match.index + (match[1]?.length ?? 0);
        if (
          !literals.some(
            (literal) => offset >= literal.index && offset < literal.index + literal[0].length,
          )
        ) {
          mentions.push({ end: offset + match[2]!.length, start: offset });
        }
      }
      return;
    }
    if (!('children' in node) || node.type === 'blockquote') return;
    for (const child of node.children) visit(child);
  }
  visit(fromMarkdown(prose));
  return mentions;
}
