import type { ProjectPickupState } from '../agent/project-pickup-state.ts';
import {
  projectPickupPolicyDigest,
  type ProjectPickupAuthority,
} from '../agent/project-pickup-authority.ts';
import decodeProjectPickup from '../channels/github/project-pickup-schema.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

export const pickupDeclaration = {
  start: '10:00',
  window: '1 hour',
  selection: { guidance: 'choose useful, ready work' },
  projects: [{ repository: 'owner/repo', milestone: { number: 10, policy: 'only' as const } }],
};

export function pickupFixture(runtime: 'codex' | 'openclaw' = 'codex') {
  const f = intakeFixture();
  f.policy.runtimes = [runtime];
  f.policy.issueAssignment!.allowed = [{ login: 'operator', nodeId: 'U_operator' }];
  f.policy.projectPickup = decodeProjectPickup(structuredClone(pickupDeclaration));
  const milestone = { nodeId: 'MI_pilot', number: 10, state: 'open' as 'open' | 'closed' };
  if (f.item.itemType === 'issue') f.item.milestone = milestone;
  f.client.getMilestone = async () => milestone;
  const authority: ProjectPickupAuthority = {
    enrollment: {
      id: 'enrollment',
      scope: 'scope',
      runtime,
      workspaceDir: '/workspace',
      agentId: 'receiver',
      account: { login: f.client.identity.login, nodeId: f.client.identity.nodeId },
      repositoryNodeId: f.repository.nodeId,
      milestoneNodeId: milestone.nodeId,
      startedAt: baseline,
      policyDigest: projectPickupPolicyDigest(f.policy),
    },
    receipts: [
      {
        enrollmentId: 'enrollment',
        issueNodeId: f.item.nodeId,
        assignmentNodeId: f.events[0]!.nodeId,
        window: { id: 'window', opensAt: baseline, closesAt: baseline + 3600000 },
      },
    ],
  };
  return {
    ...f,
    milestone,
    authority,
    input: {
      authority,
      runtime,
      scope: 'scope',
      workspaceDir: '/workspace',
      agentId: 'receiver',
      policy: f.policy,
      client: f.client,
      repository: f.repository,
      item: f.item,
      event: f.events[0]!,
      now: baseline + 7200000,
    },
  };
}

/** construct a verified assignment identity for native dispatch fixtures. */
export function retainedProjectWork(record: IntakeRecord, runtime: 'codex' | 'openclaw') {
  const f = pickupFixture(runtime);
  return {
    enrollment: {
      ...f.authority.enrollment,
      scope: record.scope,
      workspaceDir: record.workspaceDir,
      agentId: record.agentId,
      account: record.receiving,
      repositoryNodeId: record.repository.nodeId,
    },
    issueNodeId: record.issue.nodeId,
    assignmentNodeId: record.assignment.nodeId,
  };
}

/** retained assignment and reservation consumed by the native dispatch tests. */
export function reservedProjectPickup(
  record: IntakeRecord,
  runtime: 'codex' | 'openclaw',
): ProjectPickupState {
  const work = retainedProjectWork(record, runtime);
  const receipt = {
    enrollmentId: work.enrollment.id,
    issueNodeId: work.issueNodeId,
    assignmentNodeId: work.assignmentNodeId,
    window: { id: 'window', opensAt: baseline, closesAt: baseline + 3600000 },
  };
  record.evidence.projectWork = { ...work, pickup: receipt };
  record.evidence.mode = 'work';
  return {
    enrollment: work.enrollment,
    timezone: 'UTC',
    operations: [
      {
        id: 'operation',
        runId: 'pickup-run',
        repository: `${record.repository.owner.login}/${record.repository.name}`,
        phase: 'assigned',
        page: 1,
        candidates: [],
        window: receipt.window,
        selected: {
          nodeId: record.issue.nodeId,
          number: record.issue.number,
        },
        receipt,
        enrollment: work.enrollment,
      },
    ],
  };
}
