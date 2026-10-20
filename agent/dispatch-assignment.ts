import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import {
  githubIdentityMatches,
  type GitHubCanonicalWorkItem,
  type GitHubIdentity,
} from '../channels/github/provider/work-item.ts';
import type { AssignmentObservation } from './assignment-retirement.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';

/** missing membership is not authority to cancel already admitted work. */
export async function inspectAssignmentRemoval(
  record: IntakeRecord,
  client: GitHubNotificationIntakeClient,
  item: GitHubCanonicalWorkItem,
  allowed: readonly Pick<GitHubIdentity, 'login' | 'nodeId'>[],
  now: number,
): Promise<AssignmentObservation | undefined> {
  if (item.assignees.some((identity) => githubIdentityMatches(identity, client.identity))) return;
  const observation: AssignmentObservation = {
    missing: true,
    observedAt: now,
    code: 'assignment-removal-evidence-unavailable',
  };
  try {
    const history = await client.listAssignmentEvents(
      record.repository.owner.login,
      record.repository.name,
      record.issue.number,
    );
    if (history.truncated) return observation;
    const events = history.events.filter(
      (event) =>
        event.assignee.nodeId === client.identity.nodeId ||
        event.assignee.login.toLowerCase() === client.identity.login.toLowerCase(),
    );
    if (
      events.some(
        (event) =>
          !githubIdentityMatches(event.assignee, client.identity) ||
          !Number.isFinite(Date.parse(event.createdAt)) ||
          !Number.isSafeInteger(event.databaseId) ||
          event.databaseId <= 0 ||
          !event.nodeId ||
          !event.actor.nodeId ||
          !event.actor.login,
      )
    )
      return observation;
    const latest = events.sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
    )[0];
    if (!latest) return observation;
    if (
      latest.event !== 'unassigned' ||
      Date.parse(latest.createdAt) < Date.parse(record.assignment.createdAt) ||
      (Date.parse(latest.createdAt) === Date.parse(record.assignment.createdAt) &&
        latest.databaseId <= record.assignment.databaseId) ||
      !Number.isFinite(Date.parse(record.assignment.createdAt)) ||
      events.some(
        (event) =>
          event !== latest &&
          (event.nodeId === latest.nodeId || event.databaseId === latest.databaseId),
      )
    )
      return { ...observation, code: 'assignment-removal-evidence-conflicting' };
    return {
      ...observation,
      event: {
        nodeId: latest.nodeId,
        databaseId: latest.databaseId,
        createdAt: latest.createdAt,
        actor: { login: latest.actor.login, nodeId: latest.actor.nodeId },
      },
      code: allowed.some((actor) => githubIdentityMatches(actor, latest.actor))
        ? 'assignment-removal-approved'
        : 'assignment-removal-unapproved',
    };
  } catch {
    return observation;
  }
}

export async function inspectContinuedIssue(
  intake: IntakeRecord,
  client: GitHubNotificationIntakeClient,
  allowed: readonly Pick<GitHubIdentity, 'login' | 'nodeId'>[],
  record?: SharedDispatchRecord,
  now = Date.now(),
) {
  const current = await inspectActiveIssue(intake, client, true);
  const assignmentObservation = await inspectAssignmentRemoval(
    intake,
    client,
    current.item,
    allowed,
    now,
  );
  if (record) {
    if (assignmentObservation) record.assignmentObservation = assignmentObservation;
    else delete record.assignmentObservation;
  }
  if (assignmentObservation?.code === 'assignment-removal-approved')
    throw new Error('dispatch-assignment-removed');
  if (record?.retirement?.reason === 'assignment-removed') {
    const retirement = record.retirement;
    if (
      !assignmentObservation ||
      retirement.archiveAttempt ||
      retirement.archivedAt ||
      retirement.worktreeRemovalAttemptedAt ||
      retirement.worktreeRemovedAt
    )
      throw new Error('dispatch-issue-inactive');
    delete record.retirement;
  }
  return { ...current, assignmentObservation };
}

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
