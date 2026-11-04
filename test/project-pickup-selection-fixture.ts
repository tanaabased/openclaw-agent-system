import { projectPickupPolicyDigest, type ProjectWork } from '../agent/project-pickup-authority.ts';
import projectPickup, { type PickupInput } from '../agent/project-pickup.ts';
import type { ProjectPickupState } from '../agent/project-pickup-state.ts';
import type {
  ProjectPickupClient,
  ProjectCandidate,
} from '../channels/github/provider/project-pickup-client.ts';
import type {
  GitHubAssignmentEvent,
  GitHubCanonicalWorkItem,
} from '../channels/github/provider/work-item.ts';
import type { ClaimStore } from '../agent/assignment-claim.ts';
import { pickupFixture } from './project-pickup-fixture.ts';
import { baseline } from './github-intake-fixture.ts';

export default function selectionFixture(runtime: 'codex' | 'openclaw' = 'codex') {
  const f = pickupFixture(runtime);
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
  const repositories = new Map([
    [
      f.repository.name,
      { repository: f.repository, milestone: f.milestone, items, candidates, events },
    ],
  ]);
  const addRepository = (name: string, size = 1) => {
    const repository = {
      ...f.repository,
      name,
      nodeId: `R_${name}`,
      cloneUrl: `https://github.com/owner/${name}.git`,
    };
    const milestone = { ...f.milestone, nodeId: `M_${name}` };
    const projectItems = new Map<number, GitHubCanonicalWorkItem>();
    const projectCandidates = new Map<number, ProjectCandidate>();
    for (let offset = 0; offset < size; offset++) {
      const number = f.item.number + offset;
      const nodeId = `I_${name}_${number}`;
      projectItems.set(number, { ...f.item, number, nodeId, assignees: [], milestone });
      projectCandidates.set(number, { ...candidates.get(f.item.number)!, number, nodeId });
    }
    const project = {
      repository,
      milestone,
      items: projectItems,
      candidates: projectCandidates,
      events: [],
    };
    repositories.set(name, project);
    return project;
  };
  const effects = { writes: 0, saves: 0 };
  const client: ProjectPickupClient = {
    ...f.client,
    getRepository: async (_owner, name) => repositories.get(name)!.repository,
    getMilestone: async (_owner, name) => repositories.get(name)!.milestone,
    getItem: async (_owner, name, number) =>
      structuredClone(repositories.get(name)!.items.get(number)!),
    discoverProject: async (_owner, name) => ({
      candidates: [...repositories.get(name)!.candidates.values()],
    }),
    projectCandidate: async (_owner, name, number) => {
      const project = repositories.get(name)!;
      const candidate = project.candidates.get(number)!;
      return structuredClone({
        item: { ...project.items.get(number)!, title: candidate.title },
        candidate,
      });
    },
    projectBlocked: async () => false,
    listAssignmentEvents: async (_owner, name) => ({
      events: structuredClone(repositories.get(name)!.events),
      truncated: false,
    }),
    assignProjectIssue: async (_owner, name, number) => {
      const project = repositories.get(name)!;
      effects.writes++;
      project.items.get(number)!.assignees = [client.identity];
      project.events.push({
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
  const identity = { instanceId: '22222222-2222-4222-8222-222222222222', displayName: 'fixture' };
  const instance: Pick<ClaimStore, 'inspect'> = { inspect: async () => identity };
  const tx = {
    runtime,
    scope: f.authority.enrollment.scope,
    workspaceDir: '/workspace',
    agentId: 'receiver',
    enrollment: f.authority.enrollment,
    timezone: 'UTC',
    state,
    client,
    instance,
    runId: 'pickup-run',
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
  return {
    work,
    addRepository,
    identity,
    ...f,
    client,
    events,
    clock,
    effects,
    state,
    tx,
    run,
    select,
    items,
    candidates,
  };
}
