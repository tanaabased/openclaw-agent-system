import { projectPickupPolicyDigest, type ProjectWork } from '../agent/project-pickup-authority.ts';
import projectPickup, { type PickupInput, type PickupClaims } from '../agent/project-pickup.ts';
import type { AssignmentClaimState } from '../agent/assignment-claim-store.ts';
import type { ProjectPickupState } from '../agent/project-pickup-state.ts';
import type {
  ProjectPickupClient,
  ProjectCandidate,
} from '../channels/github/provider/project-pickup-client.ts';
import type {
  GitHubAssignmentEvent,
  GitHubCanonicalWorkItem,
} from '../channels/github/provider/work-item.ts';
import normalize from '../manifest/automation-schedule.ts';
import { pickupFixture } from './project-pickup-fixture.ts';
import { baseline } from './github-intake-fixture.ts';

export default function selectionFixture(runtime: 'codex' | 'openclaw' = 'codex') {
  const f = pickupFixture(runtime);
  f.policy.projectPickup!.schedule = normalize('every 1 day');
  f.authority.enrollment.policyDigest = projectPickupPolicyDigest(f.policy);
  f.authority.receipts = [];
  f.item.assignees = [];
  const items = new Map<number, GitHubCanonicalWorkItem>([[f.item.number, f.item]]);
  const candidates = new Map<number, ProjectCandidate>([
    [
      f.item.number,
      {
        nodeId: f.item.nodeId,
        number: f.item.number,
        title: 'high impact ready task',
        body: 'priority: high; fixes the current release blocker',
        labels: ['priority: high'],
      },
    ],
  ]);
  const events: GitHubAssignmentEvent[] = [];
  const clock = { now: baseline + 60000 };
  const effects = { writes: 0, saves: 0 };
  const client: ProjectPickupClient = {
    ...f.client,
    getItem: async (_owner, _name, number) => structuredClone(items.get(number)!),
    discoverProject: async () => ({ candidates: [...candidates.values()] }),
    projectCandidate: async (_owner, _name, number) => structuredClone(candidates.get(number)!),
    projectBlocked: async () => false,
    listAssignmentEvents: async () => ({ events: structuredClone(events), truncated: false }),
    assignProjectIssue: async (_owner, _name, number) => {
      effects.writes++;
      items.get(number)!.assignees = [client.identity];
      events.push({
        actor: client.identity,
        assignee: client.identity,
        event: 'assigned',
        nodeId: `E_${effects.writes}`,
        databaseId: effects.writes,
        createdAt: new Date(clock.now).toISOString(),
      });
    },
  };
  const state: {
    projectPickup?: ProjectPickupState;
    records: Array<{
      projectWork?: ProjectWork;
      retired?: object;
      issueKey: string;
      phase: string;
      request?: object;
      progression?: { stage: string };
      result?: { outcome: string };
      continuation?: { phase: string; result?: { outcome: string }; scope?: 'local' };
    }>;
  } = { records: [] };
  const claimState: AssignmentClaimState = {
    version: 1,
    instanceId: '22222222-2222-4222-8222-222222222222',
    displayName: 'pickup-fixture',
    retiredInstanceIds: [],
    claims: {},
  };
  const claims: PickupClaims = {
    passId: 'pickup-pass',
    store: {
      inspect: async () => structuredClone(claimState),
      hasClaim: async (key) => Boolean(claimState.claims[key]),
      assertUnclaimed: async (key) => {
        if (claimState.claims[key]) throw new Error('claim-disabled-pending');
      },
      exclusive: async (operation) =>
        operation(claimState, async () => {}, new AbortController().signal),
    },
    client: {
      verify: async () => {},
      list: async () => [],
      create: async () => {
        throw new Error('unexpected claim publication');
      },
      update: async () => {
        throw new Error('unexpected claim update');
      },
      remove: async () => {
        throw new Error('unexpected claim removal');
      },
    },
  };
  const tx = {
    runtime,
    scope: f.authority.enrollment.scope,
    workspaceDir: '/workspace',
    agentId: 'receiver',
    enrollment: f.authority.enrollment,
    timezone: 'UTC',
    state,
    client,
    claims,
    now: () => clock.now,
    readPolicy: async () => f.policy,
    occupied: (record: (typeof state.records)[number]) => Boolean(record.request),
    save: async () => {
      effects.saves++;
    },
  };
  const run = (input: PickupInput = {}) => projectPickup({ ...tx, input });
  const select = async () => {
    const result = await run();
    if (result.status !== 'selection-required' || !('digest' in result))
      throw new Error(`selection required: ${JSON.stringify(result)}`);
    return {
      id: result.id!,
      digest: result.digest!,
      issueNodeId: f.item.nodeId,
      rationale: 'highest explicit priority and impact among ready candidates',
    };
  };
  const work = (): ProjectWork => {
    const receipt = state.projectPickup!.operations[0]!.receipt!;
    return {
      enrollment: f.authority.enrollment,
      issueNodeId: receipt.issueNodeId,
      assignmentNodeId: receipt.assignmentNodeId,
      pickup: receipt,
    };
  };
  return { work, ...f, client, events, clock, effects, state, tx, run, select, items, candidates };
}
