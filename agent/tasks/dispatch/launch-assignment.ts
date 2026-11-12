import type { IntakeObservation } from '../../../channels/github/intake/record-store.ts';
import type IntakeRecordStore from '../../../channels/github/intake/record-store.ts';
import { githubIdentityMatches } from '../../../channels/github/provider/work-item.ts';
import type { GitHubNotificationIntakeClient } from '../../../channels/github/provider/work-event-types.ts';
import type { AssessmentEntryDependencies } from '../assessment/assessment-entry.ts';
import { automationHash } from '../../automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { OperatorIssue } from '../managed-issue.ts';
import workflowFailure from '../workflow-failure.ts';

/** assignment is optional; its exact event is consumed by the existing intake owner. */
export default async function launchAssignment(input: {
  manual: OperatorIssue;
  taskId: string;
  records: readonly SharedDispatchRecord[];
  store: IntakeRecordStore;
  client: GitHubNotificationIntakeClient;
  context: AssessmentEntryDependencies;
  save(): Promise<void>;
  claim?(event: IntakeObservation): Promise<unknown>;
}) {
  const { manual, client, context, store } = input;
  if (manual.pullRequest) return;
  const owner = manual.repository.owner.login;
  const name = manual.repository.name;
  const number = manual.issue.number;
  const attempt = (manual.assignmentAttempt ??= { attempted: false });
  await context.assertCurrent();
  let item = await client.getItem(owner, name, number);
  if (item.nodeId !== manual.issue.nodeId || item.databaseId !== manual.issue.databaseId)
    throw new Error('launch-target-identity-mismatch');
  if (!item.assignees.some((entry) => githubIdentityMatches(entry, client.identity))) {
    if (!attempt.attempted && !attempt.event) {
      attempt.attempted = true;
      await input.save();
      await context.assertCurrent();
      if (!client.assignProjectIssue) attempt.code = 'launch-assignment-unavailable';
      else {
        try {
          await client.assignProjectIssue(owner, name, number);
        } catch (error) {
          attempt.code = workflowFailure(error, 'launch-assignment-unconfirmed').code;
        }
      }
      await input.save();
    }
    item = await client.getItem(owner, name, number);
    if (item.nodeId !== manual.issue.nodeId || item.databaseId !== manual.issue.databaseId)
      throw new Error('launch-target-identity-mismatch');
    if (!item.assignees.some((entry) => githubIdentityMatches(entry, client.identity))) {
      attempt.code ??= 'launch-assignment-unconfirmed';
      await input.save();
      return;
    }
  }
  // retry reads the original event; reassignment is a different automatic input.
  if (!attempt.event) {
    try {
      const history = await client.listAssignmentEvents(owner, name, number);
      if (history.truncated) throw new Error('launch-assignment-history-incomplete');
      const event = history.events
        .filter((entry) => githubIdentityMatches(entry.assignee, client.identity))
        .sort(
          (a, b) =>
            Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
        )[0];
      if (!event || event.event !== 'assigned')
        throw new Error('launch-assignment-event-unavailable');
      attempt.event = { ...event, event: 'assigned' };
    } catch (error) {
      attempt.code = workflowFailure(error, 'launch-assignment-event-unavailable').code;
      await input.save();
      return;
    }
    delete attempt.code;
    await input.save();
  }
  const observation: IntakeObservation = {
    version: 1,
    id: automationHash([
      store.location.scope,
      manual.repository.nodeId,
      manual.issue.nodeId,
      attempt.event.nodeId,
    ]),
    scope: store.location.scope,
    receiving: manual.receiving,
    workspaceDir: manual.workspaceDir,
    agentId: manual.agentId,
    host: manual.host,
    repository: manual.repository,
    issue: manual.issue,
    assignment: attempt.event,
    observedAt: context.now,
  };
  const automatic = input.records.find((record) => record.intakeId === observation.id);
  await store.consume(observation, automatic?.id ?? input.taskId);
  if (input.claim) {
    await context.assertCurrent();
    try {
      await input.claim(observation);
      delete attempt.code;
      await input.save();
    } catch (error) {
      attempt.code = workflowFailure(error, 'launch-claim-unconfirmed').code;
      await input.save();
    }
  }
}
