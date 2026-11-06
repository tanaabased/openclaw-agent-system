import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { Value } from 'typebox/value';

import { inspectAdmittedIssue } from '../agent/dispatch-assignment.ts';
import { feedbackMode } from '../agent/feedback-work.ts';
import issueProgression from '../agent/issue-progression.ts';
import issueWorkflowMode from '../agent/issue-workflow-mode.ts';
import liveWorkflowPolicy from '../agent/live-workflow-policy.ts';
import authorizeProjectAssignment, {
  projectWorkSchema,
} from '../agent/project-pickup-authority.ts';
import projectPickupScope from '../agent/project-pickup-scope.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { githubNotificationRuntimeDiagnostics } from '../channels/github/notification-policy.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import parseAgentManifest from '../manifest/parse.ts';
import { baseline } from './github-intake-fixture.ts';
import { pickupDeclaration, pickupFixture } from './project-pickup-fixture.ts';

function parse(pickup: unknown, assignment: unknown = {}) {
  return parseAgentManifest(
    stringify({
      'schema-version': 1,
      agent: { id: 'receiver' },
      github: {
        username: 'receiver',
        'allowed-repository-owners': ['@owner'],
        'issue-assignment': assignment,
        'project-pickup': pickup,
      },
    }),
  );
}

describe('github project pickup policy', () => {
  it('should decode label filters without transforming literal values', () => {
    for (const filters of [
      undefined,
      {},
      { labels: [], 'exclude-labels': [] },
      {
        labels: ['Priority: HIGH', 'ready-to-go'],
        'exclude-labels': ['Blocked Work'],
      },
    ]) {
      const parsed = parse({
        ...pickupDeclaration,
        projects: [{ ...pickupDeclaration.projects[0], filters }],
      });
      assert.equal(parsed.status, 'valid');
      if (parsed.status !== 'valid') return;
      assert.deepEqual(
        parsed.manifest.github!.notifications!.projectPickup!.projects[0]!.filters,
        filters === undefined
          ? undefined
          : {
              ...(filters.labels ? { labels: filters.labels } : {}),
              ...(filters['exclude-labels'] ? { excludeLabels: filters['exclude-labels'] } : {}),
            },
      );
    }
    for (const filters of [
      { labels: 'bug' },
      { labels: [''] },
      { labels: ['   '] },
      { 'exclude-labels': [3] },
      { unsupported: [] },
    ]) {
      assert.equal(
        parse({ ...pickupDeclaration, projects: [{ ...pickupDeclaration.projects[0], filters }] })
          .status,
        'invalid',
      );
    }
  });

  it('should intersect pickup scope with ordered routing without consulting legacy pins', async () => {
    const f = pickupFixture();
    f.policy.routing = ['!owner/repo', '*/*'];
    assert.equal(await projectPickupScope(f.policy, f.client, f.repository), undefined);
    f.policy.routing.reverse();
    f.policy.allowedRepositoryOwners = [{ login: 'other', nodeId: 'O_other' }];
    assert.equal(await projectPickupScope(f.policy, f.client, f.repository), f.milestone);
    f.policy.routing = [];
    assert.equal(await projectPickupScope(f.policy, f.client, f.repository), undefined);
    delete f.policy.routing;
    assert.equal(await projectPickupScope(f.policy, f.client, f.repository), undefined);
  });

  it('should normalize recurring schedules and both guidance forms without activating work', () => {
    for (const guidance of ['choose useful work', { file: 'guidance/pickup.md' }]) {
      const parsed = parse({ ...pickupDeclaration, selection: { guidance } });
      assert.equal(parsed.status, 'valid');
      if (parsed.status !== 'valid') return;
      const policy = parsed.manifest.github!.notifications!;
      assert.deepEqual(policy.runtimes, ['openclaw', 'codex']);
      assert.equal(policy.projectPickup!.paused, false);
      assert.equal(policy.projectPickup!.schedule!.kind, 'cron');
      assert.deepEqual(policy.projectPickup!.selection!.guidance, guidance);
      assert.equal(issueWorkflowMode(policy, {}), 'auto');
      assert.deepEqual(policy.issueAssignment!.allowed, []);
      for (const runtime of ['codex', 'openclaw'] as const) {
        const diagnostic = githubNotificationRuntimeDiagnostics(policy, runtime).find(
          (entry) => entry.workflow === 'project-pickup',
        );
        assert.equal(diagnostic, undefined);
      }
    }
    assert.equal(parse({ ...pickupDeclaration, start: '10 am', paused: true }).status, 'valid');
  });

  it('should validate each repository and default its limit independently', () => {
    const first = pickupDeclaration.projects[0]!;
    const second = { ...structuredClone(first), repository: 'owner/second', limit: 3 };
    const parsed = parse({ ...pickupDeclaration, projects: [first, second] });
    assert.equal(parsed.status, 'valid');
    if (parsed.status !== 'valid') return;
    assert.deepEqual(
      parsed.manifest.github!.notifications!.projectPickup!.projects.map(
        (project) => project.limit,
      ),
      [1, 3],
    );
    for (const project of [
      { ...second, repository: 'other/repo' },
      { ...second, repository: 'OWNER/REPO' },
      ...[0, -1, 1.5, '3'].map((limit) => ({ ...second, limit })),
    ]) {
      assert.equal(parse({ ...pickupDeclaration, projects: [first, project] }).status, 'invalid');
    }
  });

  it('should reject unsupported pilot declarations rather than widen scope', () => {
    for (const patch of [
      { projects: [] },
      { projects: [...pickupDeclaration.projects, ...pickupDeclaration.projects] },
      { projects: [{ repository: 'owner/repo' }] },
      { projects: [{ repository: 'other/repo', milestone: { number: 1, policy: 'only' } }] },
      { projects: [{ repository: 'owner/repo', milestone: { number: 0, policy: 'only' } }] },
      { projects: [{ repository: 'owner/repo', milestone: { number: 10, policy: 'prefer' } }] },
      { 'window-minutes': 0 },
      { 'window-minutes': 1.5 },
      { paused: 'false' },
      { schedule: 'in 1 hour' },
      { schedule: { at: '2030-01-01T00:00:00Z' } },
      { schedule: { cron: '0 22 * * *', timezone: 'invalid/zone' } },
      { schedule: { every: '1 day', timezone: 'UTC' } },
      { schedule: 'bad cron' },
      { selection: { skill: 'custom:pick' } },
      { slots: [] },
    ])
      assert.equal(
        parse({ ...pickupDeclaration, ...patch }).status,
        'invalid',
        JSON.stringify(patch),
      );
    assert.equal(parse(pickupDeclaration, null).status, 'invalid');
    assert.equal(parse(pickupDeclaration, undefined).status, 'valid');
    const absent = parseAgentManifest(
      stringify({
        'schema-version': 1,
        agent: { id: 'receiver' },
        github: {
          username: 'receiver',
          'allowed-repository-owners': ['@owner'],
          'project-pickup': pickupDeclaration,
        },
      }),
    );
    assert.equal(absent.status, 'invalid');
  });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should preserve delayed pickup and work progression in ${runtime} without widening actors`, async () => {
      const f = pickupFixture(runtime);
      const before = structuredClone(f.policy.issueAssignment);
      const work = await authorizeProjectAssignment(f.input);
      assert.ok(work?.pickup);
      f.policy.projectPickup!.paused = true;
      assert.ok(await authorizeProjectAssignment(f.input));
      f.policy.projectPickup!.selection = { guidance: 'new selection advice' };
      assert.ok(
        await authorizeProjectAssignment(f.input),
        'guidance edits must not invalidate accepted assignments',
      );
      const manifest = {
        schemaVersion: 1 as const,
        agent: { id: 'receiver' },
        github: { notifications: f.policy },
      };
      const intake = {
        scope: 'scope',
        workspaceDir: '/workspace',
        agentId: 'receiver',
        receiving: f.client.identity,
        repository: f.repository,
        issue: f.item,
        assignment: structuredClone(f.events[0]),
        evidence: { projectWork: work },
      } as unknown as IntakeRecord;
      assert.equal(liveWorkflowPolicy(manifest, runtime, intake), undefined);
      f.policy.routing = [
        { match: 'owner/repo', workflows: ['issue-assignment'], target: 'deny' },
        'owner/*',
      ];
      assert.equal(liveWorkflowPolicy(manifest, runtime, intake), 'repository-outside-workflow');
      assert.equal(
        liveWorkflowPolicy(manifest, runtime, {
          ...intake,
          evidence: { ...intake.evidence, projectWork: undefined },
        }),
        'repository-outside-workflow',
      );
      f.policy.routing = undefined;
      assert.equal(liveWorkflowPolicy(manifest, runtime, intake, 'implementation'), undefined);
      const record = {
        projectWork: work,
        result: { outcome: 'plan-ready', decision: { mode: 'plan' as const } },
      };
      assert.equal(issueWorkflowMode(f.policy, record), 'work');
      assert.equal(feedbackMode(record, f.policy), 'work');
      assert.equal(
        issueProgression(record, { mode: issueWorkflowMode(f.policy, record), now: f.input.now })
          .status,
        'ready',
      );
      assert.equal(
        issueProgression(
          { ...record, continuation: { phase: 'cancelled' } },
          { mode: 'work', now: f.input.now },
        ).status,
        'stopped',
      );
      assert.equal(
        issueProgression({ ...record, retired: {} }, { mode: 'work', now: f.input.now }).status,
        'stopped',
      );
      assert.deepEqual(f.policy.issueAssignment, before);
      assert.deepEqual(
        feedbackIdentities(f.policy.issueAssignment!.allowed, f.policy.issueAssignment!.feedback),
        before!.allowed,
      );
      assert.equal(
        issueWorkflowMode(f.policy, { ...record, manualIssue: { selections: { mode: 'plan' } } }),
        'plan',
      );
      assert.equal(issueWorkflowMode(f.policy, {}), 'plan');
      await inspectAdmittedIssue(intake, f.client);
      f.milestone.state = 'closed';
      await inspectAdmittedIssue(intake, f.client);
      if (f.item.itemType === 'issue') f.item.milestone = null;
      f.client.getMilestone = async () => {
        throw new Error('milestone must not gate admitted work');
      };
      f.item.assignees.push({ login: 'collaborator', nodeId: 'U_collaborator', type: 'User' });
      await inspectAdmittedIssue(intake, f.client);
      const originalAssignees = f.item.assignees;
      f.item.assignees = [];
      await assert.rejects(inspectAdmittedIssue(intake, f.client), /dispatch-assignment-removed/);
      f.item.assignees = originalAssignees;
      f.events[0]!.nodeId = 'E_reassigned';
      await assert.rejects(
        inspectAdmittedIssue(intake, f.client),
        /dispatch-assignment-superseded/,
      );
    });

    it(`should admit a receipted assignment after disabling pickup or adding a coassignee in ${runtime}`, async () => {
      const f = pickupFixture(runtime);
      delete f.policy.projectPickup;
      f.item.assignees.push({ login: 'collaborator', nodeId: 'U_collaborator', type: 'User' });
      const work = await authorizeProjectAssignment(f.input);
      assert.ok(work?.pickup);
      assert.equal(issueWorkflowMode(f.policy, { projectWork: work }), 'work');
      f.authority.receipts = [];
      assert.equal(await authorizeProjectAssignment(f.input), undefined);
    });

    it(`should require a pickup receipt even for new approved scoped assignments in ${runtime}`, async () => {
      const f = pickupFixture(runtime);
      f.authority.receipts[0]!.assignmentNodeId = 'unrelated-assignment';
      f.client.getRepository =
        f.client.getItem =
        f.client.listAssignmentEvents =
          async () => {
            throw new Error('pickup must not read providers without a matching receipt');
          };
      assert.equal(await authorizeProjectAssignment(f.input), undefined);
      f.authority.receipts = [];
      assert.equal(await authorizeProjectAssignment(f.input), undefined);
      f.input.event.actor = { ...f.policy.issueAssignment!.allowed[0]!, type: 'User' };
      assert.equal(await authorizeProjectAssignment(f.input), undefined);
      assert.equal(
        Value.Check(projectWorkSchema, {
          enrollment: f.authority.enrollment,
          issueNodeId: f.item.nodeId,
          assignmentNodeId: f.events[0]!.nodeId,
        }),
        false,
      );
      f.authority.enrollment.startedAt = Date.parse(f.input.event.createdAt);
      assert.equal(await authorizeProjectAssignment(f.input), undefined);
    });
  }

  it('should reject mismatched authority, future assignment and stale provider facts', async () => {
    const changes: Array<(f: ReturnType<typeof pickupFixture>) => void> = [
      (f) => {
        f.authority.receipts = [];
      },
      (f) => {
        f.input.runtime = 'openclaw';
      },
      (f) => {
        f.authority.enrollment.scope = 'other';
      },
      (f) => {
        f.authority.enrollment.workspaceDir = '/other';
      },
      (f) => {
        f.authority.enrollment.account = { login: 'other', nodeId: 'U_other' };
      },
      (f) => {
        f.authority.enrollment.repositoryNodeId = 'R_other';
      },
      (f) => {
        f.input.event.createdAt = new Date(f.input.now + 1000).toISOString();
      },
      (f) => {
        f.input.event.nodeId = 'E_other';
      },
      (f) => {
        f.input.event.assignee = { login: 'other', nodeId: 'U_other', type: 'User' };
      },
      (f) => {
        f.repository.archived = true;
      },
      (f) => {
        f.policy.allowedRepositoryOwners = [];
      },
      (f) => {
        f.client.getItem = async () => ({ ...f.item, state: 'closed' });
      },
      (f) => {
        f.client.getItem = async () => ({ ...f.item, assignees: [] });
      },
      (f) => {
        f.input.now = NaN;
      },
      (f) => {
        f.client.listAssignmentEvents = async () => ({
          truncated: false,
          events: [
            ...f.events,
            {
              ...f.events[0]!,
              event: 'unassigned',
              nodeId: 'E_removed',
              databaseId: 31,
              createdAt: new Date(baseline + 120000).toISOString(),
            },
          ],
        });
      },
    ];
    for (const change of changes) {
      const f = pickupFixture();
      change(f);
      assert.equal(await authorizeProjectAssignment(f.input), undefined, change.toString());
    }
  });

  it('should retain a verified assignment after pickup milestone and window changes', async () => {
    const f = pickupFixture();
    const original = structuredClone(f.authority.enrollment);
    f.policy.projectPickup!.projects[0]!.milestone.number = 11;
    f.policy.projectPickup!.windowMinutes = 30;
    if (f.item.itemType === 'issue') f.item.milestone = null;
    const work = await authorizeProjectAssignment(f.input);
    assert.deepEqual(work!.enrollment, original);
    f.authority.receipts = [];
    assert.equal(await authorizeProjectAssignment(f.input), undefined);
  });

  it('should distinguish unavailable milestones from an empty or out-of-scope result', async () => {
    const f = pickupFixture();
    assert.ok(await projectPickupScope(f.policy, f.client, f.repository));
    assert.equal(
      await projectPickupScope(f.policy, f.client, { ...f.repository, name: 'other' }),
      undefined,
    );
    f.milestone.state = 'closed';
    await assert.rejects(
      projectPickupScope(f.policy, f.client, f.repository),
      /project-pickup-milestone-closed/,
    );
    f.client.getMilestone = undefined;
    await assert.rejects(
      projectPickupScope(f.policy, f.client, f.repository),
      /project-pickup-milestone-unavailable/,
    );
    for (const status of [403, 404]) {
      const error = new GitHubWorkEventClientError(
        'github-failed',
        'failed',
        {},
        undefined,
        providerDiagnostic('github', 'api-request', 'permission', { httpStatus: status }),
      );
      f.client.getMilestone = async () => {
        throw error;
      };
      await assert.rejects(
        projectPickupScope(f.policy, f.client, f.repository),
        (caught) => caught === error,
      );
    }
  });
});
