import type assignmentIntakePolicy from './assignment-intake-policy.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';

/** Recheck provider authority before either runtime acts on retained admission evidence. */
export default async function revalidateAssignment(
  policy: NonNullable<ReturnType<typeof assignmentIntakePolicy>>,
  record: IntakeRecord,
  client: GitHubNotificationIntakeClient,
) {
  if (
    !githubIdentityMatches(client.identity, record.receiving) ||
    client.identity.login.toLowerCase() !== policy.username.toLowerCase()
  )
    throw new Error('dispatch-receiver-authority-revoked');
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
  if (
    repo.nodeId !== record.repository.nodeId ||
    repo.databaseId !== record.repository.databaseId ||
    repo.archived ||
    repo.disabled ||
    !policy.policy.allowedRepositoryOwners.some((identity) =>
      githubIdentityMatches(identity, repo.owner),
    ) ||
    !githubIdentityMatches(record.repository.owner, repo.owner) ||
    repo.name.toLowerCase() !== name.toLowerCase() ||
    item.nodeId !== record.issue.nodeId ||
    item.databaseId !== record.issue.databaseId ||
    item.number !== record.issue.number ||
    item.itemType !== 'issue' ||
    item.state !== 'open' ||
    !item.assignees.some((identity) => githubIdentityMatches(identity, client.identity)) ||
    !latest ||
    latest.event !== 'assigned' ||
    latest.actor.type !== 'User' ||
    !policy.policy.issueAssignment?.allowed.some((identity) =>
      githubIdentityMatches(identity, latest.actor),
    )
  )
    throw new Error('dispatch-assignment-authority-revoked');
  if (latest.nodeId !== record.assignment.nodeId) throw new Error('dispatch-assignment-superseded');
  if (!githubIdentityMatches(latest.actor, record.assignment.actor))
    throw new Error('dispatch-assignment-authority-revoked');
  return repo;
}
