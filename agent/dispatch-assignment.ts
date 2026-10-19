import type assignmentIntakePolicy from './assignment-intake-policy.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';

/** Recheck provider authority before either runtime acts on retained admission evidence. */
export async function inspectAssignment(
  policy: NonNullable<ReturnType<typeof assignmentIntakePolicy>>,
  record: IntakeRecord,
  client: GitHubNotificationIntakeClient,
) {
  if (
    !githubIdentityMatches(client.identity, record.receiving) ||
    client.identity.login.toLowerCase() !== policy.username.toLowerCase()
  )
    throw new Error('dispatch-receiver-account-changed');
  const owner = record.repository.owner.login;
  const name = record.repository.name;
  const repo = await client.getRepository(owner, name);
  const item = await client.getItem(owner, name, record.issue.number);
  const events = await client.listAssignmentEvents(owner, name, record.issue.number);
  if (events.truncated) throw new Error('dispatch-authority-history-incomplete');
  const latest = events.events
    .filter((event) => githubIdentityMatches(event.assignee, client.identity))
    .sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
    )[0];
  if (repo.nodeId !== record.repository.nodeId || repo.databaseId !== record.repository.databaseId)
    throw new Error('dispatch-repository-identity-changed');
  if (repo.archived) throw new Error('dispatch-repository-archived');
  if (repo.disabled) throw new Error('dispatch-repository-disabled');
  if (!githubIdentityMatches(record.repository.owner, repo.owner))
    throw new Error('dispatch-repository-owner-changed');
  if (repo.name.toLowerCase() !== name.toLowerCase())
    throw new Error('dispatch-repository-name-changed');
  if (
    !policy.policy.allowedRepositoryOwners.some((identity) =>
      githubIdentityMatches(identity, repo.owner),
    )
  )
    throw new Error('dispatch-repository-owner-not-allowed');
  if (
    item.nodeId !== record.issue.nodeId ||
    item.databaseId !== record.issue.databaseId ||
    item.number !== record.issue.number
  )
    throw new Error('dispatch-issue-identity-changed');
  if (item.itemType !== 'issue') throw new Error('dispatch-issue-type-changed');
  if (item.state !== 'open') throw new Error('dispatch-issue-closed');
  return { repo, item, latest };
}

export async function inspectAssignedIssue(
  policy: NonNullable<ReturnType<typeof assignmentIntakePolicy>>,
  record: IntakeRecord,
  client: GitHubNotificationIntakeClient,
) {
  const { repo, item, latest } = await inspectAssignment(policy, record, client);
  if (!item.assignees.some((identity) => githubIdentityMatches(identity, client.identity)))
    throw new Error('dispatch-assignment-removed');
  if (!latest) throw new Error('dispatch-assignment-event-missing');
  if (latest.event !== 'assigned') throw new Error('dispatch-assignment-removed');
  if (latest.actor.type !== 'User') throw new Error('dispatch-assignment-actor-type-changed');
  if (
    !policy.policy.issueAssignment?.allowed.some((identity) =>
      githubIdentityMatches(identity, latest.actor),
    )
  )
    throw new Error('dispatch-assignment-actor-not-allowed');
  if (latest.nodeId !== record.assignment.nodeId) {
    const order =
      Date.parse(latest.createdAt) - Date.parse(record.assignment.createdAt) ||
      latest.databaseId - record.assignment.databaseId;
    throw new Error(
      order > 0 ? 'dispatch-assignment-superseded' : 'dispatch-authority-history-incomplete',
    );
  }
  if (!githubIdentityMatches(latest.actor, record.assignment.actor))
    throw new Error('dispatch-assignment-actor-changed');
  return { repo, item, latest };
}

export default async function revalidateAssignment(
  ...input: Parameters<typeof inspectAssignedIssue>
) {
  return (await inspectAssignedIssue(...input)).repo;
}
