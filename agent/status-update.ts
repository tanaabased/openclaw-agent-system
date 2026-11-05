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
  if (target.source) throw new Error('status-update-item-required');
  const discussion = await provider.listIssueComments(target.owner, target.name, target.number);
  const number = target.itemType === 'pull-request' ? target.number : retainedPullRequest;
  const pullRequests = [];
  if (number !== undefined) {
    const item = await provider.getItem(target.owner, target.name, number);
    if (
      item.itemType !== 'pull-request' ||
      item.pullRequest.baseRepositoryNodeId !== target.repositoryNodeId
    )
      throw new Error('status-update-pr-diverged');
    pullRequests.push({
      url: `https://github.com/${target.owner}/${target.name}/pull/${number}`,
      item,
    });
  }
  const linked = pullRequests.find(
    ({ item }) =>
      item.number === retainedPullRequest && item.state === 'open' && !item.pullRequest.merged,
  );
  return { discussion, pullRequests, defaultDestination: linked?.url ?? target.destination };
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
