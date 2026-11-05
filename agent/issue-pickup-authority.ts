import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { automationHash } from './automation-hash.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import {
  githubIdentityMatches,
  type GitHubAssignmentEvent,
  type GitHubCanonicalWorkItem,
  type GitHubRepositoryIdentity,
} from '../channels/github/provider/work-item.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import repositoryScope from '../channels/github/repository-scope.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const identity = Type.Object({ login: text, nodeId: text }, { additionalProperties: false });
export const issuePickupEnrollmentSchema = Type.Object(
  {
    id: text,
    scope: text,
    runtime: Type.Union([Type.Literal('codex'), Type.Literal('openclaw')]),
    workspaceDir: text,
    agentId: text,
    account: identity,
    repositoryNodeId: text,
    milestoneNodeId: text,
    policyDigest: text,
    startedAt: time,
  },
  { additionalProperties: false },
);
export const issuePickupReceiptSchema = Type.Object(
  {
    enrollmentId: text,
    issueNodeId: text,
    assignmentNodeId: text,
    window: Type.Object(
      { id: text, opensAt: time, closesAt: time },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const projectWorkSchema = Type.Object(
  {
    enrollment: issuePickupEnrollmentSchema,
    issueNodeId: text,
    assignmentNodeId: text,
    pickup: issuePickupReceiptSchema,
  },
  { additionalProperties: false },
);
export type ProjectWork = Static<typeof projectWorkSchema>;

/** supplied only by the native enrollment/selection owner, never by model-facing inputs. */
export interface IssuePickupAuthority {
  enrollment: Static<typeof issuePickupEnrollmentSchema>;
  receipts: readonly Static<typeof issuePickupReceiptSchema>[];
  retained?: readonly ProjectWork[];
  withheldAssignments?: readonly { issueNodeId: string; assignmentNodeId?: string }[];
}

/** enrollment binds scope and native timing; live guidance and pause do not require reenrollment. */
export function issuePickupPolicyDigest(policy: GitHubNotificationPolicy) {
  const pickup = policy.issuePickup;
  return automationHash(
    pickup
      ? {
          projects: pickup.projects.map(({ repository, milestone }) => ({ repository, milestone })),
          schedule: pickup.schedule,
          windowMinutes: pickup.windowMinutes,
        }
      : null,
  );
}

interface AssignmentInput {
  authority: IssuePickupAuthority;
  runtime: 'codex' | 'openclaw' | undefined;
  scope: string;
  workspaceDir: string;
  agentId: string;
  policy: GitHubNotificationPolicy;
  client: GitHubNotificationIntakeClient;
  repository: GitHubRepositoryIdentity;
  item: GitHubCanonicalWorkItem;
  event: GitHubAssignmentEvent;
  now: number;
}

function assignmentReceipt({ authority, item, event }: AssignmentInput) {
  const retained = authority.retained?.find(
    (work) =>
      Value.Check(projectWorkSchema, work) &&
      work.issueNodeId === item.nodeId &&
      work.assignmentNodeId === event.nodeId &&
      work.pickup &&
      work.pickup.enrollmentId === work.enrollment.id &&
      work.pickup.issueNodeId === work.issueNodeId &&
      work.pickup.assignmentNodeId === work.assignmentNodeId,
  );
  const enrollment = retained?.enrollment ?? authority.enrollment;
  const receipt =
    retained?.pickup ??
    authority.receipts.find(
      (entry) =>
        Value.Check(issuePickupReceiptSchema, entry) &&
        entry.enrollmentId === enrollment.id &&
        entry.issueNodeId === item.nodeId &&
        entry.assignmentNodeId === event.nodeId,
    );
  return receipt ? { enrollment, receipt } : undefined;
}

/** admission-time grant: callers must retain it, never derive one for old managed work. */
export default async function authorizeProjectAssignment(
  input: AssignmentInput,
): Promise<ProjectWork | undefined> {
  if (!assignmentReceipt(input)) return;
  const { client, repository, item } = input;
  const freshRepository = await client.getRepository(repository.owner.login, repository.name);
  const freshItem = await client.getItem(repository.owner.login, repository.name, item.number);
  if (
    freshRepository.nodeId !== repository.nodeId ||
    freshRepository.databaseId !== repository.databaseId ||
    freshItem.nodeId !== item.nodeId ||
    freshItem.databaseId !== item.databaseId
  )
    return;
  const history = await client.listAssignmentEvents(
    repository.owner.login,
    repository.name,
    item.number,
  );
  return verifyProjectAssignment({
    ...input,
    repository: freshRepository,
    item: freshItem,
    history,
  });
}

/** verify fresh provider observations supplied by the native pickup or intake owner. */
export function verifyProjectAssignment(
  input: AssignmentInput & {
    history: Awaited<ReturnType<GitHubNotificationIntakeClient['listAssignmentEvents']>>;
  },
): ProjectWork | undefined {
  const { policy, client, repository, item, event } = input;
  const matched = assignmentReceipt(input);
  if (!matched) return;
  const { enrollment, receipt } = matched;
  const assignedAt = Date.parse(event.createdAt);
  if (
    !Value.Check(issuePickupEnrollmentSchema, enrollment) ||
    enrollment.runtime !== input.runtime ||
    !policy.issueAssignment ||
    !policy.runtimes.includes(enrollment.runtime) ||
    enrollment.scope !== input.scope ||
    enrollment.workspaceDir !== input.workspaceDir ||
    enrollment.agentId !== input.agentId ||
    !githubIdentityMatches(enrollment.account, client.identity) ||
    enrollment.repositoryNodeId !== repository.nodeId ||
    !Number.isSafeInteger(input.now) ||
    !Number.isFinite(assignedAt) ||
    assignedAt <= enrollment.startedAt ||
    assignedAt > input.now ||
    event.event !== 'assigned' ||
    !githubIdentityMatches(event.assignee, client.identity)
  )
    return;
  if (
    !githubIdentityMatches(event.actor, client.identity) ||
    receipt.window.closesAt <= receipt.window.opensAt ||
    assignedAt < receipt.window.opensAt
  )
    return;
  if (
    repository.archived ||
    repository.disabled ||
    (policy.routing === undefined &&
      repositoryScope(policy, repository, 'issue-pickup').decision === 'deny') ||
    item.itemType !== 'issue' ||
    item.state !== 'open' ||
    !item.assignees.some((assignee) => githubIdentityMatches(assignee, client.identity))
  )
    return;
  const { history } = input;
  if (history.truncated) throw new Error('issue-pickup-assignment-history-incomplete');
  const latest = history.events
    .filter((entry) => githubIdentityMatches(entry.assignee, client.identity))
    .sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
    )[0];
  if (
    !latest ||
    latest.event !== 'assigned' ||
    latest.nodeId !== event.nodeId ||
    latest.createdAt !== event.createdAt ||
    !githubIdentityMatches(latest.actor, event.actor)
  )
    return;
  return {
    enrollment: structuredClone(enrollment),
    issueNodeId: item.nodeId,
    assignmentNodeId: event.nodeId,
    pickup: structuredClone(receipt),
  };
}

/** private retained evidence cannot stand in for a different assignment or account. */
export function projectWorkMatches(
  work: ProjectWork | undefined,
  record: {
    scope: string;
    workspaceDir: string;
    agentId: string;
    receiving: { login: string; nodeId: string };
    repository: { nodeId: string };
    issue: { nodeId: string };
    assignment?: { nodeId: string };
  },
) {
  return Boolean(
    work &&
    Value.Check(projectWorkSchema, work) &&
    work.enrollment.scope === record.scope &&
    work.enrollment.workspaceDir === record.workspaceDir &&
    work.enrollment.agentId === record.agentId &&
    githubIdentityMatches(work.enrollment.account, record.receiving) &&
    work.enrollment.repositoryNodeId === record.repository.nodeId &&
    work.issueNodeId === record.issue.nodeId &&
    work.assignmentNodeId === record.assignment?.nodeId &&
    work.pickup.enrollmentId === work.enrollment.id &&
    work.pickup.issueNodeId === work.issueNodeId &&
    work.pickup.assignmentNodeId === work.assignmentNodeId,
  );
}

export function retainedPickupReceipt(record: IntakeRecord) {
  const work = record.evidence?.projectWork;
  return work?.pickup && projectWorkMatches(work, record) ? work.pickup : undefined;
}
