import {
  projectPickupPolicyDigest,
  type ProjectPickupAuthority,
} from '../agent/project-pickup-authority.ts';
import normalizeAutomationSchedule from '../manifest/automation-schedule.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

export const pickupDeclaration = {
  schedule: { cron: '0 22 * * *', timezone: 'America/New_York' },
  'window-minutes': 60,
  selection: { guidance: 'choose useful, ready work' },
  projects: [{ repository: 'owner/repo', milestone: { number: 10, policy: 'only' } }],
};

export function pickupFixture(runtime: 'codex' | 'openclaw' = 'codex') {
  const f = intakeFixture();
  f.policy.runtimes = [runtime];
  f.policy.issueAssignment!.allowed = [{ login: 'operator', nodeId: 'U_operator' }];
  f.policy.projectPickup = {
    paused: false,
    schedule: normalizeAutomationSchedule(pickupDeclaration.schedule),
    windowMinutes: 60,
    selection: pickupDeclaration.selection,
    projects: [{ repository: 'owner/repo', milestone: { number: 10, policy: 'only' } }],
  };
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

/** stand in for the future selector's already verified admission receipt. */
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
