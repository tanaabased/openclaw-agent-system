import { fromMarkdown } from 'mdast-util-from-markdown';

type MarkdownNode =
  ReturnType<typeof fromMarkdown> | ReturnType<typeof fromMarkdown>['children'][number];

/** link ordinary prose mentions by source range, never by reserializing provider markdown. */
export default function mentionLinks(body: string): string {
  if (!body.includes('@')) return body;
  const literals = [
    ...body.matchAll(
      /\b(?:[a-z][a-z\d+.-]*:|www\.)[^\s<>]+|"[^"\r\n]+"@[a-z\d.-]+|[\p{L}\p{N}_][\p{L}\p{N}_.!#$%&'*+/=?^`{|}~-]*@[a-z\d.-]+/giu,
    ),
  ];
  const parts: string[] = [];
  let cursor = 0;
  function visit(node: MarkdownNode): void {
    if (node.type === 'text') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const raw = body.slice(start, end);
      // unresolved markup is not a reliable place to insert a new markdown link.
      if (/[[\]`<>]/u.test(raw)) return;
      const linked = raw.replace(
        /(?<![\p{L}\p{N}_@/\\.+-])@([a-z\d](?:[a-z\d-]*[a-z\d])?)(?![\p{L}\p{N}_@/-]|\.[\p{L}\p{N}])/giu,
        (token: string, login: string, offset: number) =>
          login.length <= 39 &&
          !login.includes('--') &&
          !literals.some(
            (literal) =>
              start + offset >= literal.index && start + offset < literal.index + literal[0].length,
          )
            ? `[${token}](https://github.com/${login})`
            : token,
      );
      if (linked !== raw) {
        parts.push(body.slice(cursor, start), linked);
        cursor = end;
      }
      return;
    }
    if (
      !('children' in node) ||
      node.type === 'link' ||
      node.type === 'linkReference' ||
      (node.type !== 'root' && node.children.some((child) => child.type === 'html'))
    )
      return;
    for (const child of node.children) visit(child);
  }
  visit(fromMarkdown(body));
  return parts.length ? parts.join('') + body.slice(cursor) : body;
}
