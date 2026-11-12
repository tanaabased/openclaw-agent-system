import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { stringify } from 'yaml';

import { inspectAdmittedIssue } from '../agent/dispatch-assignment.ts';
import { feedbackConversationMode } from '../agent/tasks/feedback/feedback-conversation-mode.ts';
import authorizeProjectAssignment, { projectWorkSchema } from '../agent/issue-pickup-authority.ts';
import issuePickupScope from '../agent/issue-pickup-scope.ts';
import issueProgression from '../agent/issue-progression.ts';
import issueWorkflowMode from '../agent/issue-workflow-mode.ts';
import liveWorkflowPolicy from '../agent/live-workflow-policy.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { githubNotificationRuntimeDiagnostics } from '../channels/github/notification-policy.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import parseAgentManifest from '../manifest/parse.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import { baseline } from './github-intake-fixture.ts';
import { pickupDeclaration, pickupFixture } from './issue-pickup-fixture.ts';

function parse(pickup: unknown, assignment: unknown = {}) {
  return parseAgentManifest(
    stringify({
      'schema-version': 1,
      agent: { id: 'receiver' },
      github: {
        username: 'receiver',
        routing: ['owner/*'],
        'issue-assignment': assignment,
        'issue-pickup': pickup,
      },
    }),
  );
}

describe('github issue pickup policy', () => {
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
        parsed.manifest.github!.notifications!.issuePickup!.projects[0]!.filters,
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

  it('should intersect pickup scope with ordered routing', async () => {
    const f = pickupFixture();
    f.policy.routing = ['!owner/repo', '*/*'];
    assert.equal(await issuePickupScope(f.policy, f.client, f.repository), undefined);
    f.policy.routing.reverse();
    assert.deepEqual(await issuePickupScope(f.policy, f.client, f.repository), {
      policy: 'only',
      milestoneNodeIds: [f.milestone.nodeId],
      discoveryMilestone: 10,
    });
    f.policy.routing = [];
    assert.equal(await issuePickupScope(f.policy, f.client, f.repository), undefined);
  });

  for (const milestone of [
    undefined,
    { number: 10 },
    { number: [10, 11] },
    { number: [10, 11], policy: 'prefer' },
  ]) {
    it(`should accept pickup scope ${JSON.stringify(milestone)}`, () => {
      assert.equal(
        parse({
          ...pickupDeclaration,
          projects: [{ repository: 'owner/repo', ...(milestone ? { milestone } : {}) }],
        }).status,
        'valid',
      );
    });
  }

  it('should resolve all selected milestones once and default to only', async () => {
    const f = pickupFixture();
    f.policy.issuePickup!.projects[0]!.milestone = { number: [10, 11] };
    const calls: number[] = [];
    f.client.getMilestone = async (_owner, _name, number) => {
      calls.push(number);
      return { number, nodeId: `M_${number}`, state: 'open' };
    };
    assert.deepEqual(await issuePickupScope(f.policy, f.client, f.repository), {
      policy: 'only',
      milestoneNodeIds: ['M_10', 'M_11'],
    });
    assert.deepEqual(calls, [10, 11]);
    delete f.policy.issuePickup!.projects[0]!.milestone;
    assert.deepEqual(await issuePickupScope(f.policy, f.client, f.repository), {
      policy: 'all',
      milestoneNodeIds: [],
    });
    assert.deepEqual(calls, [10, 11]);
  });

  it('should normalize recurring schedules and both guidance forms without activating work', () => {
    for (const guidance of ['choose useful work', { file: 'guidance/pickup.md' }]) {
      const parsed = parse({ ...pickupDeclaration, selection: { guidance } });
      assert.equal(parsed.status, 'valid');
      if (parsed.status !== 'valid') return;
      const policy = parsed.manifest.github!.notifications!;
      assert.deepEqual(policy.runtimes, ['openclaw', 'codex']);
      assert.equal(policy.issuePickup!.paused, false);
      assert.equal(policy.issuePickup!.schedule!.kind, 'cron');
      assert.deepEqual(policy.issuePickup!.selection!.guidance, guidance);
      assert.equal(issueWorkflowMode(policy, {}), 'auto');
      assert.deepEqual(policy.issueAssignment!.allowed, []);
      for (const runtime of ['codex', 'openclaw'] as const) {
        const diagnostic = githubNotificationRuntimeDiagnostics(policy, runtime).find(
          (entry) => entry.workflow === 'issue-pickup',
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
      parsed.manifest.github!.notifications!.issuePickup!.projects.map((project) => project.limit),
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
      ...[[], [1, 1], [0], [1.5], ['1']].map((number) => ({
        projects: [{ repository: 'owner/repo', milestone: { number } }],
      })),
      { projects: [] },
      { projects: [...pickupDeclaration.projects, ...pickupDeclaration.projects] },
      { projects: [{ repository: 'other/repo', milestone: { number: 1, policy: 'only' } }] },
      { projects: [{ repository: 'owner/repo', milestone: { number: 0, policy: 'only' } }] },
      { projects: [{ repository: 'owner/repo', milestone: { number: 10, policy: 'unknown' } }] },
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
          routing: ['owner/*'],
          'issue-pickup': pickupDeclaration,
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
      f.policy.issuePickup!.paused = true;
      assert.ok(await authorizeProjectAssignment(f.input));
      f.policy.issuePickup!.selection = { guidance: 'new selection advice' };
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
      f.policy.routing = ['owner/*'];
      assert.equal(liveWorkflowPolicy(manifest, runtime, intake, 'implementation'), undefined);
      const record = {
        projectWork: work,
        implementationDecision: { mode: 'plan' as const, reasons: ['Plan only.'] },
      };
      assert.equal(issueWorkflowMode(f.policy, record), 'work');
      assert.equal(feedbackConversationMode(record, f.policy), 'work');
      assert.equal(
        issueProgression(record, { mode: issueWorkflowMode(f.policy, record) }).status,
        'ready',
      );
      assert.equal(
        issueProgression({ ...record, nativeWork: { cancelled: true } }, { mode: 'work' }).status,
        'stopped',
      );
      assert.equal(issueProgression({ ...record, reset: {} }, { mode: 'work' }).status, 'stopped');
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
      delete f.policy.issuePickup;
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
    f.policy.routing = [];
    const original = structuredClone(f.authority.enrollment);
    f.policy.issuePickup!.projects[0]!.milestone!.number = 11;
    f.policy.issuePickup!.windowMinutes = 30;
    if (f.item.itemType === 'issue') f.item.milestone = null;
    const work = await authorizeProjectAssignment(f.input);
    assert.deepEqual(work!.enrollment, original);
    f.authority.receipts = [];
    assert.equal(await authorizeProjectAssignment(f.input), undefined);
  });

  it('should distinguish unavailable milestones from an empty or out-of-scope result', async () => {
    const f = pickupFixture();
    assert.ok(await issuePickupScope(f.policy, f.client, f.repository));
    assert.equal(
      await issuePickupScope(f.policy, f.client, { ...f.repository, name: 'other' }),
      undefined,
    );
    f.milestone.state = 'closed';
    await assert.rejects(
      issuePickupScope(f.policy, f.client, f.repository),
      /issue-pickup-milestone-closed/,
    );
    f.client.getMilestone = undefined;
    await assert.rejects(
      issuePickupScope(f.policy, f.client, f.repository),
      /issue-pickup-milestone-unavailable/,
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
        issuePickupScope(f.policy, f.client, f.repository),
        (caught) => caught === error,
      );
    }
  });
});
