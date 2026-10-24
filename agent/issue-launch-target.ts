import { replyLocator } from './reply-target.ts';

/** canonicalize explicit references; callers supply only independently verified repository context. */
export default function issueLaunchTarget(target: string, repository?: string) {
  const value = target.trim();
  if (/^https:\/\//u.test(value)) {
    const locator = replyLocator(value);
    if (locator.kind || locator.itemType !== 'issue') throw new Error('launch-open-issue-required');
    const slug = `${locator.owner}/${locator.name}`;
    if (repository && repository.toLowerCase() !== slug.toLowerCase())
      throw new Error('launch-repository-conflict');
    return {
      repository: slug,
      number: locator.number,
      url: `https://github.com/${slug}/issues/${locator.number}`,
    };
  }
  const qualified = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#|\s+#?)([1-9][0-9]*)$/u.exec(value);
  const bare = /^#?([1-9][0-9]*)$/u.exec(value);
  if (!qualified && !bare) throw new Error('launch-issue-reference-invalid');
  const slug = qualified?.[1] ?? repository;
  if (!slug) return;
  if (repository && qualified && repository.toLowerCase() !== qualified[1]!.toLowerCase())
    throw new Error('launch-repository-conflict');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(slug))
    throw new Error('launch-repository-invalid');
  const number = Number(qualified?.[2] ?? bare?.[1]);
  if (!Number.isSafeInteger(number)) throw new Error('launch-issue-number-invalid');
  return { repository: slug, number, url: `https://github.com/${slug}/issues/${number}` };
}
