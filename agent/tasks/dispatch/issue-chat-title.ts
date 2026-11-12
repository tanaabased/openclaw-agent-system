export const issueChatTitleGuidance =
  'Supply title as a short two-to-six-word description of the work, without repository or issue-number prefixes. Prefer simple wording; punctuation and Unicode are allowed. The runtime adds the issue prefix and uppercase presentation.';

/** remove only matching leading metadata; punctuation and references in the description stay. */
export default function issueChatTitle(title: string, number: number, repository: string): string {
  const repositories = [repository, repository.split('/').at(-1)!]
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|');
  const issue = `(?:(?:${repositories})\\s*)?#${number}(?:\\s*[:–—-]\\s*|\\s+|$)`;
  const prefix = new RegExp(`^(?:${issue}|(?:${repositories})\\s*:\\s*)`, 'iu');
  let description = title.trim();
  while (prefix.test(description)) description = description.replace(prefix, '').trim();
  return `#${number}: ${(description || 'issue').toUpperCase()}`;
}
