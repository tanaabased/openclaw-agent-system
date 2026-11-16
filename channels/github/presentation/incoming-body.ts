import { fromMarkdown } from 'mdast-util-from-markdown';

import { validateGitHubNotificationPublicationMarker } from '../publication/publication-contract.ts';

type MarkdownNode =
  ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

/** omit publication metadata only in display copies, preserving markdown source ranges. */
export default function incomingBody(body: string): string {
  if (!body.includes('<!-- agent-system-github-publication:')) return body;
  const parts: string[] = [];
  let cursor = 0;
  function visit(node: MarkdownNode): void {
    if (node.type === 'html') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (const match of body.slice(start, end).matchAll(/<!--[\s\S]*?-->/gu)) {
        try {
          validateGitHubNotificationPublicationMarker(match[0]);
        } catch {
          continue;
        }
        const offset = start + match.index;
        parts.push(body.slice(cursor, offset));
        cursor = offset + match[0].length;
      }
      return;
    }
    if ('children' in node) for (const child of node.children) visit(child);
  }
  visit(fromMarkdown(body));
  return parts.length ? parts.join('') + body.slice(cursor) : body;
}
