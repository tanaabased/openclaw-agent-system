import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';

/** existing task access is provider-owned; only identity and lifecycle are local. */
export async function inspectActiveIssue(
  record: IntakeRecord,
  client: GitHubNotificationIntakeClient,
  feedbackOnly = false,
) {
  if (!githubIdentityMatches(client.identity, record.receiving))
    throw new Error('dispatch-receiver-account-changed');
  const owner = record.repository.owner.login;
  const name = record.repository.name;
  const repo = await client.getRepository(owner, name);
  const item = await client.getItem(owner, name, record.issue.number);
  if (repo.nodeId !== record.repository.nodeId || repo.databaseId !== record.repository.databaseId)
    throw new Error('dispatch-repository-identity-changed');
  if (
    item.nodeId !== record.issue.nodeId ||
    item.databaseId !== record.issue.databaseId ||
    item.number !== record.issue.number ||
    item.itemType !== 'issue'
  )
    throw new Error('dispatch-issue-identity-changed');
  if (item.state !== 'open') throw new Error('dispatch-issue-closed');
  if (
    !feedbackOnly &&
    !item.assignees.some((identity) => githubIdentityMatches(identity, client.identity))
  )
    throw new Error('dispatch-assignment-removed');
  return { repo, item };
}

/** an unsubmitted dispatch retains its exact admitted assignment, independent of new defaults. */
export async function inspectAdmittedIssue(
  record: IntakeRecord,
  client: GitHubNotificationIntakeClient,
) {
  const current = await inspectActiveIssue(record, client);
  const events = await client.listAssignmentEvents(
    record.repository.owner.login,
    record.repository.name,
    record.issue.number,
  );
  if (events.truncated) throw new Error('dispatch-authority-history-incomplete');
  const latest = events.events
    .filter((event) => githubIdentityMatches(event.assignee, client.identity))
    .sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
    )[0];
  if (!latest) throw new Error('dispatch-assignment-event-missing');
  if (latest.event !== 'assigned') throw new Error('dispatch-assignment-removed');
  if (latest.nodeId !== record.assignment.nodeId) throw new Error('dispatch-assignment-superseded');
  if (!githubIdentityMatches(latest.actor, record.assignment.actor))
    throw new Error('dispatch-assignment-actor-changed');
  return current;
}
