import { automationHash } from './automation-hash.ts';
import type { OpenClawFeedbackProvider } from './openclaw-feedback.ts';
import type { ReplyTarget } from './reply-target.ts';
import type { StatusUpdate } from '../tools/dispatch/reply-schema.ts';

/** bounded provider observations stay separate from the model's materiality judgment. */
export default async function statusUpdateContext(
  provider: OpenClawFeedbackProvider,
  target: ReplyTarget,
  retainedPullRequest?: number,
) {
  if (target.itemType !== 'issue' || target.source) throw new Error('status-update-issue-required');
  const issue = await provider.getItemContext(target.owner, target.name, target.number, 'issue');
  if (issue.truncated) throw new Error('status-update-context-incomplete');
  const links = [issue.body, ...issue.comments.map((comment) => comment.body)].join('\n');
  const numbers = new Set<number>(retainedPullRequest ? [retainedPullRequest] : []);
  for (const match of links.matchAll(
    /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\b/gu,
  )) {
    if (
      match[1]!.toLowerCase() === target.owner.toLowerCase() &&
      match[2]!.toLowerCase() === target.name.toLowerCase()
    )
      numbers.add(Number(match[3]));
  }
  if (numbers.size > 3) throw new Error('status-update-context-incomplete');
  const pullRequests = [];
  for (const number of numbers) {
    const item = await provider.getItem(target.owner, target.name, number);
    if (
      item.itemType !== 'pull-request' ||
      item.pullRequest.baseRepositoryNodeId !== target.repositoryNodeId
    )
      throw new Error('status-update-pr-diverged');
    const context = await provider.getItemContext(
      target.owner,
      target.name,
      number,
      'pull-request',
    );
    if (context.truncated) throw new Error('status-update-context-incomplete');
    pullRequests.push({
      url: `https://github.com/${target.owner}/${target.name}/pull/${number}`,
      item,
      context,
    });
  }
  return { issue, pullRequests };
}

/** effect identity follows cited facts, not wording, public chatter, or native turn ids. */
export function statusUpdateIdentity(update: StatusUpdate) {
  const facts = update.facts.map(({ key, reference, revision }) => ({
    key: key.trim(),
    reference: reference.trim(),
    revision: revision.trim(),
  }));
  if (
    facts.some((fact) => !fact.key || !fact.reference || !fact.revision) ||
    update.facts.some((fact) => !fact.text.trim()) ||
    new Set(facts.map((fact) => fact.key)).size !== facts.length
  )
    throw new Error('status-update-facts-invalid');
  return facts.sort((left, right) => left.key.localeCompare(right.key));
}

export function statusUpdateObservation(publicContext: unknown, owner: unknown) {
  return automationHash({ publicContext, owner });
}
