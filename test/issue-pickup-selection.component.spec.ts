import { withDispatchTask } from '../agent/tasks/dispatch/dispatch-task-scope.ts';
import { omit } from 'lodash-es';
import type { RepositoryRoute } from '../channels/github/repository-scope.ts';
import type { Static } from 'typebox';
import type { issuePickupSchema } from '../channels/github/issue-pickup-schema.ts';
import AssignmentClaimStore from '../agent/tasks/dispatch/assignment-claim-store.ts';
import IssuePickupEnrollmentStore from '../agent/issue-pickup-enrollment.ts';
import assert from 'node:assert/strict';
import IssuePickupFailure from '../agent/issue-pickup-failure.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import codexCapacity from '../agent/tasks/dispatch/codex-capacity.ts';
import CodexDispatchStore from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import {
  prepareCodexPickupEnrollment,
  runCodexIntake,
  runCodexIssuePickup,
  type CodexIntakeDependencies,
} from '../agent/codex-intake.ts';
import { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import { bindCodexWorkspace } from '../agent/identity/codex-workspace-binding.ts';
import openClawCapacity from '../agent/tasks/dispatch/openclaw-capacity.ts';
import OpenClawDispatchStore from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import { issuePickupPolicyDigest } from '../agent/issue-pickup-authority.ts';
import type { PickupInput } from '../agent/issue-pickup.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import parseAgentManifest from '../manifest/parse.ts';
import { baseline } from './github-intake-fixture.ts';
import selectionFixture from './issue-pickup-selection-fixture.ts';
import pickupClaims from './issue-pickup-claim-fixture.ts';
import CodexAssignmentClaims from '../agent/tasks/dispatch/codex-assignment-claims.ts';
import OpenClawAssignmentClaims from '../agent/tasks/dispatch/openclaw-assignment-claims.ts';
import GitHubIssuePickupClient from '../channels/github/provider/issue-pickup-client.ts';
import GitHubWorkEventApiClient, {
  GitHubWorkEventClientError,
} from '../channels/github/provider/work-event-api-client.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

describe('issue pickup selection through native journals', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pickup-selection-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(
    runtime: 'codex' | 'openclaw',
    coordinated = false,
    initialScope?: 'all' | 'multiple' | 'prefer' | 'namespace',
  ) {
    const f = selectionFixture(runtime);
    const workspace = join(root, 'workspace');
    const data = join(root, 'data');
    const home = join(root, 'codex');
    await mkdir(workspace);
    await mkdir(home);
    const instanceRoot = join(data, 'instance');
    await new AssignmentClaimStore(instanceRoot).identity();
    const enrollmentStore = new IssuePickupEnrollmentStore(instanceRoot);
    const caller = { current: true };
    const connectionFailure: { error?: Error } = {};
    const connect = async () => {
      if (connectionFailure.error) throw connectionFailure.error;
      return f.client;
    };
    const tick = { id: 'pickup-turn-1' };
    const claims = coordinated ? pickupClaims(f, instanceRoot) : undefined;
    const assertCurrent = async () => {
      if (!caller.current) throw new Error('issue-pickup-native-caller-required');
    };
    const occurrence = {
      nativeId: 'pickup-job',
      get runId() {
        return tick.id;
      },
      assertCurrent,
    };

    const declaration = {
      'schema-version': 1,
      debug: false,
      agent: { id: 'receiver' },
      github: {
        username: 'receiver',
        runtimes: [runtime],
        routing: (coordinated ? [{ 'owner/*': 'swarm' }] : ['owner/*']) as RepositoryRoute[],
        'max-concurrent-items': 1,
        'issue-assignment': {
          mode: 'plan',
          allowed: [
            { login: 'operator', 'node-id': 'U_operator' },
            { login: 'receiver', 'node-id': 'U_receiver' },
          ],
        },
        'issue-pickup': {
          paused: false,
          start: '10:00',
          window: '1 hour',
          selection: { guidance: { file: 'selection.md' } },
          projects: [
            { repository: 'owner/repo', milestone: { number: 10, policy: 'only' }, limit: 1 },
          ] as Static<typeof issuePickupSchema>['projects'],
        },
      },
    };
    if (initialScope === 'namespace') {
      declaration.github['issue-pickup'].projects = [
        {
          repository: 'owner/*',
          limit: { quantity: 1, scope: 'selection' },
          milestone: { ids: ['repo#10'] },
        },
      ];
    } else if (initialScope === 'all') {
      delete declaration.github['issue-pickup'].projects[0]!.milestone;
      f.item.milestone = null;
    } else if (initialScope === 'multiple') {
      declaration.github['issue-pickup'].projects[0]!.milestone = { number: [9, 10] };
      const readMilestone = f.client.getMilestone!;
      f.client.getMilestone = async (owner, name, number) =>
        number === 9
          ? { number: 9, nodeId: 'M_second', state: 'open' }
          : readMilestone(owner, name, number);
    } else if (initialScope === 'prefer') {
      declaration.github['issue-pickup'].projects[0]!.milestone = {
        number: 10,
        policy: 'prefer',
      };
      f.item.milestone = null;
    }
    const source = JSON.stringify(declaration);
    await writeFile(join(workspace, 'agent.yaml'), source);
    await writeFile(join(workspace, 'selection.md'), 'prefer high impact ready work');
    const parsed = parseAgentManifest(source);
    assert.equal(parsed.status, 'valid');
    if (parsed.status !== 'valid') throw new Error('fixture invalid');
    const manifest = parsed.manifest;
    f.clock.now = baseline;
    let pickup: (input?: PickupInput) => ReturnType<typeof runCodexIssuePickup>;
    let scan: () => Promise<unknown>;
    let read: () => Promise<IntakeRecord[]>;
    let journal: CodexDispatchStore | OpenClawDispatchStore;
    let scope: string;
    if (runtime === 'codex') {
      await bindCodexWorkspace(data, workspace);
      const deps: CodexIntakeDependencies = {
        codexHome: home,
        now: () => f.clock.now,
        assertActive: async () => {},
        connect,
        threadId: 'pickup-thread',
        pickupActivation: async (accepted) => {
          if (manifest.github!.notifications!.issuePickup!.paused && !accepted)
            throw new Error('issue-pickup-paused');
          return { threadId: 'pickup-thread', nativeId: 'pickup-job' };
        },
        intakeNative: {
          occurrence: async () => {
            await assertCurrent();
            return {
              id: tick.id,
              automationId: 'pickup-job',
              currentTimeIso: new Date(f.clock.now).toISOString(),
            };
          },
        },
      };
      await runCodexIntake(data, true, deps);
      const selected = await selectCodexTaskContext(data, deps);
      scope = selected.store.location.scope;
      journal = new CodexDispatchStore(data, scope);
      const enrollment = await prepareCodexPickupEnrollment(data, deps);
      await enrollmentStore.activate(enrollment.enrollment.id, occurrence.nativeId);
      Object.assign(f.authority.enrollment, enrollment.enrollment);
      pickup = (input = {}) =>
        withDispatchTask('codex', 'pickup-thread', () =>
          runCodexIssuePickup(data, input, 'UTC', deps),
        );
      scan = () => runCodexIntake(data, false, deps);
      read = async () => (await selected.store.read())!.records;
    } else {
      const intake = new OpenClawIntake({
        root: data,
        pickupStore: enrollmentStore,
        namespace: root,
        now: () => f.clock.now,
        readiness: async () => undefined,
        connect,
        manifestService: {
          loadForAgentId: async () => ({
            status: 'loaded',
            manifest,
            scope: { workspaceDir: workspace, agentId: 'receiver' },
            path: join(workspace, 'agent.yaml'),
            digest: 'fixture',
            diagnostics: [],
            validationChecks: [],
          }),
        },
      });
      await intake.run(manifest, workspace, 'activate');
      const selected = await intake.select(manifest, workspace);
      scope = selected.store.location.scope;
      journal = new OpenClawDispatchStore(data, scope);
      const enrollment = await intake.preparePickup(manifest, workspace);
      await enrollmentStore.activate(enrollment.enrollment.id, occurrence.nativeId);
      Object.assign(f.authority.enrollment, enrollment.enrollment);
      pickup = (input = {}) => intake.pickup(manifest, workspace, input, 'UTC', occurrence);
      scan = () => intake.run(manifest, workspace, 'scan');
      read = async () => (await selected.store.read())!.records;
    }
    Object.assign(f.authority.enrollment, {
      scope,
      workspaceDir: workspace,
      policyDigest: issuePickupPolicyDigest(manifest.github!.notifications!),
    });
    f.clock.now += 60000;
    const select = async () => {
      const result = await pickup();
      assert.equal(result.status, 'selection-required');
      assert.ok('digest' in result);
      return {
        issueNodeId: f.item.nodeId,
        rationale: 'highest explicit priority and impact among ready work',
      };
    };
    const configure = async (change: (value: typeof declaration) => void) => {
      change(declaration);
      const source = JSON.stringify(declaration);
      const updated = parseAgentManifest(source);
      assert.equal(updated.status, 'valid');
      if (updated.status !== 'valid') throw new Error('invalid fixture update');
      Object.assign(manifest, updated.manifest);
      await writeFile(join(workspace, 'agent.yaml'), source);
    };
    return {
      ...f,
      pickup,
      scan,
      read,
      journal,
      select,
      caller,
      tick,
      claims,
      instanceRoot,
      configure,
      enrollmentStore,
      connectionFailure,
    };
  }

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should enroll a namespace and retain its allowance through the native ${runtime} journal`, async () => {
      const f = await fixture(runtime, false, 'namespace');
      const selection = await f.select();
      assert.equal((await f.pickup({ selection })).status, 'assigned');
      await f.scan();
      const records = await f.read();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.evidence.projectWork!.pickup.issueNodeId, f.item.nodeId);
      f.tick.id = 'namespace-after-restart';
      const exhausted = await f.pickup();
      assert.equal(exhausted.status, 'allowance-reached');
      const saved = await f.journal.read();
      assert.equal(saved.projectPickup!.charges![0]!.selection, 'owner/*');
      assert.equal(f.effects.writes, 1);
    });
    it(`should keep pickup available beside an independently damaged task in ${runtime}`, async () => {
      const f = await fixture(runtime);
      await f.configure((source) => {
        source.github['max-concurrent-items'] = 2;
      });
      const damaged = {
        id: 'd'.repeat(64),
        intakeId: 'd'.repeat(64),
        issueKey: 'd'.repeat(64),
        sourceThreadId: 'assignment-thread',
        threadId: 'damaged-task-thread',
        createdAt: 'invalid',
        manifestDigest: 'manifest',
      };
      await f.journal.file.write(
        JSON.stringify({ ...(await f.journal.read()), records: [damaged] }),
      );
      const selection = await f.select();
      assert.equal((await f.pickup({ selection })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
      assert.deepEqual(JSON.parse(await readFile(f.journal.path, 'utf8')).records, [damaged]);
    });

    it(`should finish an accepted selection while its schedule is paused in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      await f.configure((source) => {
        source.github['issue-pickup'].paused = true;
      });
      assert.equal((await f.pickup({ selection })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
      f.tick.id = 'next-paused-run';
      if (runtime === 'codex') await assert.rejects(f.pickup(), /issue-pickup-paused/);
      else assert.notEqual((await f.pickup()).status, 'assigned');
      assert.equal(f.effects.writes, 1);
    });

    it(`should page captured repository guidance and retain scope through ${runtime}`, async () => {
      const f = await fixture(runtime);
      const guidance = 'repository-specific priorities '.repeat(700);
      await f.configure((source) => {
        source.github['issue-pickup'].projects[0]!.selection = { guidance };
      });
      const options = await f.pickup();
      assert.ok('digest' in options);
      const restored = await hydrateImplementation(options, ({ action, ...input }) => {
        assert.equal(action, 'pickup');
        return f.pickup(input as PickupInput);
      });
      assert.deepEqual(restored.repositoryGuidance, {
        'owner/repo': { source: 'inline', content: guidance },
      });
      const result = await f.pickup({
        selection: {
          issueNodeId: f.item.nodeId,
          rationale: 'ready within repository guidance',
        },
      });
      assert.equal(result.status, 'assigned');
      assert.doesNotMatch(result.response, /repository-specific priorities/);
      assert.equal(
        (await f.journal.read()).projectPickup!.operations[0]!.repositoryGuidance,
        undefined,
      );
    });
    it(`should capture per-repository file guidance and isolate unreadable repositories through ${runtime}`, async () => {
      const f = await fixture(runtime);
      const workspace = join(root, 'workspace');
      const other = f.addRepository('other', 2);
      await writeFile(join(workspace, 'other.md'), 'prioritize other releases');
      await f.configure((source) => {
        source.debug = true;
        source.github['issue-pickup'].projects[0]!.selection = {
          guidance: 'prioritize repo fixes',
        };
        source.github['issue-pickup'].projects.push({
          repository: 'owner/other',
          milestone: { number: 10, policy: 'only' },
          limit: 1,
          selection: { guidance: { file: 'other.md' } },
        });
      });
      const options = await f.pickup();
      assert.ok('repositoryGuidance' in options && options.repositoryGuidance);
      assert.equal(options.repositoryGuidance['owner/repo']!.content, 'prioritize repo fixes');
      assert.equal(options.repositoryGuidance['owner/other']!.content, 'prioritize other releases');
      await rm(join(workspace, 'other.md'));
      const result = await f.pickup({
        selection: {
          issueNodeId: other.items.get(f.item.number)!.nodeId,
          rationale: 'other release ready',
          shortlist: [f.item.nodeId, other.items.get(f.item.number)!.nodeId],
        },
      });
      assert.equal(result.status, 'assigned');
      assert.match(result.response, /owner\/repo.*0 of 1 assigned.*1 eligible/);
      assert.match(result.response, /owner\/other.*1 of 1 assigned.*2 eligible/);
      assert.match(result.response, /owner\/repo\/issues\/3/);
      assert.match(result.response, /owner\/other\/issues\/3/);
      assert.match(result.response, /prioritize other releases/);
      const saved = await f.journal.read();
      assert.equal(saved.projectPickup!.operations[0]!.repositoryGuidance, undefined);
      assert.equal(saved.projectPickup!.charges![0]!.repositoryNodeId, other.repository.nodeId);

      await f.configure((source) => {
        source.debug = false;
        source.github['issue-pickup'].projects[1]!.limit = 2;
      });
      f.tick.id = 'missing-repository-guidance';
      const readable = await f.select();
      const partial = await f.pickup({ selection: { ...readable, issueNodeId: null } });
      assert.equal(partial.status, 'empty');
      assert.match(partial.response, /owner\/repo.*1 eligible/);
      assert.match(partial.response, /owner\/other.*dispatch-assessment-guidance-unreadable/);
      assert.doesNotMatch(partial.response, /prioritize other releases|prioritize repo fixes/);

      await writeFile(join(workspace, 'other.md'), 'updated repository priorities');
      f.tick.id = 'restored-repository-guidance';
      const refreshed = await f.pickup();
      assert.ok('repositoryGuidance' in refreshed && refreshed.repositoryGuidance);
      assert.equal(
        refreshed.repositoryGuidance['owner/other']!.content,
        'updated repository priorities',
      );
      assert.equal(f.effects.writes, 1);
    });

    it(`should preserve repository provider errors on the consolidated card through ${runtime}`, async () => {
      const f = await fixture(runtime);
      f.addRepository('other');
      await f.configure((source) =>
        source.github['issue-pickup'].projects.push({
          repository: 'owner/other',
          milestone: { number: 10, policy: 'only' },
          limit: 1,
        }),
      );
      const read = f.client.getRepository;
      const diagnostic = providerDiagnostic('github', 'api-request', 'permission', {
        httpStatus: 403,
        providerMessage: 'Repository access denied',
      });
      f.client.getRepository = async (owner, name) => {
        if (name === 'other')
          throw new GitHubWorkEventClientError(
            'github-notification-request-failed',
            'denied',
            {},
            undefined,
            diagnostic,
          );
        return read(owner, name);
      };
      const selection = await f.select();
      const result = await f.pickup({ selection });
      assert.equal(result.status, 'assigned');
      assert.match(
        result.response,
        /owner\/other.*eligible count unavailable.*github-notification-request-failed.*Repository access denied/,
      );
      assert.match(result.response, /owner\/repo.*1 of 1 assigned.*1 eligible/);
      assert.deepEqual(result.allowances?.[1]?.providerDiagnostic, diagnostic);
      assert.equal(f.effects.writes, 1);
    });
    it(`should filter native types and recheck changed types through ${runtime}`, async () => {
      const f = await fixture(runtime);
      const enrollment = await f.enrollmentStore.read();
      await f.configure((source) => {
        source.github['issue-pickup'].projects[0]!.filters = {
          types: ['BUG', 'Customer Request'],
          labels: ['priority:*', '!blocked'],
        };
      });
      const candidate = f.candidates.get(f.item.number)!;
      candidate.issueType = { name: 'Task' };
      assert.equal((await f.pickup()).status, 'empty');
      candidate.issueType = { name: 'Bug' };
      f.tick.id = 'matching-type';
      const selection = await f.select();
      candidate.issueType = null;
      const rejected = await f.pickup({ selection });
      assert.equal(rejected.status, 'failed');
      assert.equal(f.effects.writes, 0);
      delete candidate.issueType;
      f.tick.id = 'missing-type-evidence';
      const unreadable = await f.pickup();
      assert.equal(unreadable.status, 'empty');
      assert.match(unreadable.response, /could not be read/);
      assert.equal(f.effects.writes, 0);
      candidate.issueType = { name: 'customer request' };
      f.tick.id = 'matching-custom-type';
      assert.equal((await f.pickup({ selection: await f.select() })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
      assert.deepEqual(await f.enrollmentStore.read(), enrollment);
      await f.scan();
      assert.equal((await f.read())[0]!.evidence.mode, 'work');
    });

    it(`should retain label filters for preferred fallback through ${runtime}`, async () => {
      const f = await fixture(runtime, false, 'prefer');
      await f.configure((source) => {
        source.github['issue-pickup'].projects[0]!.filters = {
          labels: ['PRIORITY:*', '!block*'],
        };
      });
      const preferred = {
        ...f.item,
        number: f.item.number + 1,
        nodeId: 'I_preferred',
        milestone: f.milestone,
      };
      f.items.set(preferred.number, preferred);
      f.candidates.set(preferred.number, {
        ...f.candidates.get(f.item.number)!,
        nodeId: preferred.nodeId,
        number: preferred.number,
        labels: ['priority: high', 'blocked'],
      });
      const context = await f.pickup();
      assert.ok('candidates' in context);
      assert.deepEqual(
        context.candidates?.map((candidate) => [candidate.nodeId, candidate.pickupScope]),
        [[f.item.nodeId, 'fallback']],
      );
      const selection = {
        ...(await f.select()),
        fallback: { repository: 'owner/repo', reason: 'preferred work is excluded by labels' },
      };
      f.candidates.get(f.item.number)!.labels.push('blocked');
      const result = await f.pickup({ selection });
      assert.equal(result.status, 'failed');
      assert.match(result.response, /issue-pickup-candidate-ineligible/);
      assert.equal(f.effects.writes, 0);
    });

    for (const scope of ['all', 'multiple', 'prefer'] as const) {
      it(`should activate ${scope} scope and retain its assignment through ${runtime}`, async () => {
        const f = await fixture(runtime, false, scope);
        const result = await f.pickup({
          selection: {
            ...(await f.select()),
            ...(scope === 'prefer'
              ? { fallback: { repository: 'owner/repo', reason: 'no suitable preferred work' } }
              : {}),
          },
        });
        assert.equal(result.status, 'assigned');
        assert.equal(f.effects.writes, 1);
        if (scope === 'prefer') assert.match(result.response, /Fallback.*selected repository/);
        assert.match(result.response, /owner\/repo/);
        await f.configure((source) => {
          delete source.github['issue-pickup'].projects[0]!.milestone;
        });
        await f.scan();
        const records = await f.read();
        assert.equal(records.length, 1);
        assert.equal(records[0]!.evidence.mode, 'work');
        assert.equal(
          records[0]!.evidence.projectWork!.pickup!.assignmentNodeId,
          f.events[0]!.nodeId,
        );
      });
    }

    it(`should apply live preferred edits without replacing activation through ${runtime}`, async () => {
      const f = await fixture(runtime);
      const stale = await f.select();
      await f.configure((source) => {
        source.github['issue-pickup'].projects[0]!.milestone = { number: [10], policy: 'prefer' };
      });
      f.item.milestone = null;
      assert.equal((await f.pickup({ selection: stale })).status, 'failed');
      assert.equal(f.effects.writes, 0);
      const result = await f.pickup({
        selection: {
          ...(await f.select()),
          fallback: { repository: 'owner/repo', reason: 'no preferred candidate is suitable' },
        },
      });
      assert.equal(result.status, 'assigned');
      assert.match(result.response, /Fallback/);
    });

    for (const boundary of ['milestone', 'discovery'] as const) {
      it(`should preserve ${boundary} failure instead of falling back through ${runtime}`, async () => {
        const f = await fixture(runtime, false, 'prefer');
        const diagnostic = providerDiagnostic('github', 'api-request', 'permission', {
          httpStatus: 403,
          providerMessage: 'preferred read denied',
        });
        const fail = async () => {
          throw new GitHubWorkEventClientError(
            'github-notification-request-failed',
            'preferred read denied',
            {},
            undefined,
            diagnostic,
          );
        };
        if (boundary === 'milestone') f.client.getMilestone = fail;
        else f.client.discoverProject = fail;
        const result = await f.pickup();
        assert.equal(result.status, 'failed');
        assert.match(result.response, /preferred read denied/);
        assert.equal(f.effects.writes, 0);
      });
    }

    it(`should recover an uncertain fallback after scope removal through ${runtime}`, async () => {
      const f = await fixture(runtime, false, 'prefer');
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw new Error('response lost');
      };
      const result = await f.pickup({
        selection: {
          ...(await f.select()),
          fallback: { repository: 'owner/repo', reason: 'no preferred work is suitable' },
        },
      });
      assert.equal(result.status, 'attempted');
      await f.configure((source) => {
        delete source.github['issue-pickup'].projects[0]!.milestone;
      });
      const recovered = await f.pickup();
      assert.equal(recovered.status, 'assigned');
      assert.match(recovered.response, /Fallback within the selected repository/);
      assert.equal(f.effects.writes, 1);
      await f.scan();
      assert.equal((await f.read())[0]!.evidence.mode, 'work');
    });

    it(`should reload label criteria and report empty scans without installation changes in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const enrollment = await f.enrollmentStore.read();
      const blocked = { ...f.item, number: f.item.number + 1, nodeId: 'I_blocked' };
      f.items.set(blocked.number, blocked);
      f.candidates.set(blocked.number, {
        ...f.candidates.get(f.item.number)!,
        nodeId: blocked.nodeId,
        number: blocked.number,
        labels: ['priority: high', 'blocked'],
      });
      await f.configure((source) => {
        source.github['issue-pickup'].projects[0]!.filters = {
          labels: ['priority:*', 'unknown required', '!block*'],
        };
      });
      const empty = await f.pickup();
      assert.equal(empty.status, 'empty');
      assert.match(empty.response, /unknown required/);
      assert.match(empty.response, /No eligible issues matched/);
      assert.equal(f.effects.writes, 0);
      f.tick.id = 'edited-filters';
      await f.configure((source) => {
        source.github['issue-pickup'].projects[0]!.filters = {
          labels: ['!unknown*', '!BLOCK*'],
        };
      });
      const options = await f.pickup();
      assert.ok('candidates' in options && options.candidates);
      assert.deepEqual(
        options.candidates.map((candidate) => candidate.nodeId),
        [f.item.nodeId],
      );
      const selection = await f.select();
      const current = f.candidates.get(f.item.number)!;
      current.title = 'edited title';
      current.body = 'edited body';
      current.labels.push('unrelated');
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw new Error('response lost');
      };
      assert.equal((await f.pickup({ selection })).status, 'attempted');
      await f.configure((source) => {
        source.github['issue-pickup'].projects[0]!.filters = { labels: ['not present anymore'] };
      });
      f.tick.id = 'recover-after-edit';
      assert.equal((await f.pickup()).status, 'assigned');
      assert.equal(f.effects.writes, 1);
      assert.deepEqual(await f.enrollmentStore.read(), enrollment);
    });

    for (const change of ['required', 'excluded'] as const) {
      it(`should refuse a newly disqualifying ${change} label before assignment in ${runtime}`, async () => {
        const f = await fixture(runtime);
        await f.configure((source) => {
          source.github['issue-pickup'].projects[0]!.filters = {
            labels: ['priority:*', '!block*'],
          };
        });
        const selection = await f.select();
        f.candidates.get(f.item.number)!.labels =
          change === 'required' ? [] : ['priority: high', 'blocked'];
        const result = await f.pickup({ selection });
        assert.equal(result.status, 'failed');
        assert.match(result.response, /issue-pickup-candidate-ineligible/);
        assert.equal(f.effects.writes, 0);
      });
    }

    it(`should report missing guidance before selection without discarding its diagnostic through ${runtime}`, async () => {
      const f = await fixture(runtime);
      await rm(join(root, 'workspace', 'selection.md'));
      await assert.rejects(f.pickup(), (error: unknown) => {
        assert.ok(error instanceof IssuePickupFailure);
        assert.equal(error.code, 'dispatch-assessment-guidance-unreadable');
        assert.match(error.failure.response, /dispatch-assessment-guidance-unreadable/);
        assert.match(error.failure.response, /restore a readable/);
        assert.doesNotMatch(error.failure.response, /Guidance source|Selected|no eligible/);
        return true;
      });
      assert.equal(f.effects.writes, 0);
    });

    it(`should preserve a pre-scan provider failure and shared card through ${runtime}`, async () => {
      const f = await fixture(runtime);
      const diagnostic = providerDiagnostic('github', 'client-create', 'authentication', {
        httpStatus: 401,
        providerMessage: 'Bad credentials',
      });
      f.connectionFailure.error = new GitHubWorkEventClientError(
        'github-client-unavailable',
        'Bad credentials',
        {},
        undefined,
        diagnostic,
      );
      await assert.rejects(f.pickup(), (error: unknown) => {
        assert.ok(error instanceof IssuePickupFailure);
        assert.equal(error.code, 'github-client-unavailable');
        assert.equal(error.failure.status, 'error');
        assert.equal(error.failure.providerDiagnostic?.httpStatus, 401);
        assert.match(error.failure.response, /❌.*Issue pickup/);
        assert.match(error.failure.response, /github-client-unavailable/);
        assert.match(error.failure.response, /Bad credentials/);
        assert.match(error.failure.response, /Next/);
        assert.doesNotMatch(error.failure.response, /Selected|no eligible|Debug/);
        if (runtime === 'codex') assert.equal(error.automationId, 'pickup-job');
        return true;
      });
      assert.equal(f.effects.writes, 0);
    });

    for (const debug of [false, true]) {
      it(`should report the captured file guidance after deletion with debug ${debug} through ${runtime}`, async () => {
        const f = await fixture(runtime);
        await f.configure((source) => {
          source.debug = debug;
        });
        const selection = await f.select();
        const path = join(root, 'workspace', 'selection.md');
        await writeFile(path, 'changed priorities must not be reported');
        await rm(path);
        const result = await f.pickup({ selection });
        assert.equal(result.status, 'assigned');
        assert.equal('selectionGuidance' in result, false);
        if (debug) {
          assert.match(result.response, /Guidance source.*file/);
          assert.match(result.response, /prefer high impact ready work/);
        } else assert.doesNotMatch(result.response, /Guidance|prefer high impact ready work|Debug/);
        assert.doesNotMatch(result.response, /changed priorities/);
        if (runtime === 'codex') assert.match(result.response, /<decision>NOTIFY<\/decision>/);
        const retained = (await f.journal.read()).projectPickup!.operations[0]!;
        assert.equal(retained.guidance, undefined);
        assert.equal(retained.guidanceSource, undefined);
        assert.equal(retained.guidancePath, undefined);
        await writeFile(path, 'new guidance for later scans');
        const exhausted = await f.pickup();
        assert.doesNotMatch(exhausted.response, /Guidance|prefer high impact ready work/);
        assert.equal(f.effects.writes, 1);
      });
    }
    it(`should reconcile a removed repository and retain its allowance across live limits in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const other = f.addRepository('other', 2);
      const project = {
        repository: 'owner/other',
        milestone: { number: 10, policy: 'only' as const },
        limit: 2,
      };
      const before = await f.enrollmentStore.read();
      await f.configure((source) => source.github['issue-pickup'].projects.push(project));
      const selection = await f.select();
      const target = other.items.get(f.item.number)!;
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw new Error('response lost');
      };
      assert.equal(
        (await f.pickup({ selection: { ...selection, issueNodeId: target.nodeId } })).status,
        'attempted',
      );
      await f.configure((source) => source.github['issue-pickup'].projects.pop());
      f.tick.id = 'recover-write';
      const recovered = await f.pickup();
      assert.equal(recovered.status, 'assigned');
      assert.equal(f.effects.writes, 1);
      assert.match(recovered.response, /owner\/other\/issues\/3/);
      assert.equal((await f.pickup()).status, 'scan-complete');

      f.client.discoverAssigned = async () => ({
        candidates: [
          {
            nodeId: target.nodeId,
            databaseId: target.databaseId,
            number: target.number,
            itemType: 'issue',
            updatedAt: target.updatedAt,
            repositoryPath: '/repos/owner/other',
          },
        ],
        incomplete: false,
        totalCount: 1,
        truncated: false,
      });
      await f.scan();
      const record = (await f.read())[0]!;
      assert.equal(record.repository.nodeId, other.repository.nodeId);
      assert.equal(record.evidence.mode, 'work');

      f.client.assignProjectIssue = assign;
      await f.configure((source) =>
        source.github['issue-pickup'].projects.push({ ...project, limit: 1 }),
      );
      f.tick.id = 'lowered-limit';
      const lower = await f.pickup();
      assert.equal(lower.status, 'selection-required');
      assert.ok(
        'candidates' in lower &&
          lower.candidates?.every((entry) => entry.repository !== 'owner/other'),
      );
      await f.configure((source) => {
        source.github['issue-pickup'].projects[1]!.limit = 2;
      });
      f.tick.id = 'raised-limit';
      const raised = await f.pickup();
      assert.equal(raised.status, 'selection-required');
      assert.ok(
        'candidates' in raised &&
          raised.candidates?.some((entry) => entry.repository === 'owner/other'),
      );
      const second = other.items.get(f.item.number + 1)!;
      const assigned = await f.pickup({
        selection: {
          issueNodeId: second.nodeId,
          rationale: 'ready',
        },
      });
      assert.equal(assigned.status, 'assigned');
      assert.match(assigned.response, /owner\/repo.*0 of 1 assigned/);
      assert.match(assigned.response, /owner\/other.*2 of 2 assigned/);
      assert.equal(f.effects.writes, 2);
      assert.deepEqual(await f.enrollmentStore.read(), before);
    });

    it(`should refresh file guidance across runs and preserve uncertain-write recovery in ${runtime}`, async () => {
      const f = await fixture(runtime);
      await f.select();
      const previousDigest = (await f.journal.read()).projectPickup!.operations[0]!.selectionDigest;
      const path = join(root, 'workspace', 'selection.md');
      await writeFile(path, 'prefer release blockers');
      f.tick.id = 'later-native-run';
      const fresh = await f.pickup();
      assert.equal(fresh.status, 'selection-required');
      assert.ok('guidance' in fresh && 'digest' in fresh);
      assert.equal((fresh.guidance as { path: string }).path, path);
      assert.equal(await readFile(path, 'utf8'), 'prefer release blockers');
      assert.notEqual(fresh.digest, previousDigest);
      assert.equal(f.effects.writes, 0);
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw new Error('response lost');
      };
      assert.equal((await f.pickup({ selection: await f.select() })).status, 'attempted');
      await rm(path);
      f.tick.id = 'recovery-run';
      assert.equal((await f.pickup()).status, 'assigned');
      assert.equal(f.effects.writes, 1);
    });

    it(`should reject copied snapshot overrides and refresh current guidance in ${runtime}`, async () => {
      const f = await fixture(runtime);
      await writeFile(join(root, 'workspace', 'selection.md'), 'Selection guidance. '.repeat(800));
      const first = await f.pickup();
      assert.ok('digest' in first);
      assert.equal('contextMaterials' in first, false);
      const input = { selection: { ...(await f.select()), digest: first.digest } };
      await writeFile(join(root, 'workspace', 'selection.md'), 'changed selection priorities');
      f.tick.id = 'new-scan';
      await assert.rejects(f.pickup(input as PickupInput), /issue-pickup-input-invalid/);
      const fresh = await f.pickup();
      assert.equal(fresh.status, 'selection-required');
      assert.ok('digest' in fresh && 'digest' in first);
      assert.notEqual(fresh.digest, first.digest);
      assert.equal(f.effects.writes, 0);
    });

    it(`should retain receipt-based work intake after removing pickup configuration in ${runtime}`, async () => {
      const f = await fixture(runtime);
      assert.equal((await f.pickup({ selection: await f.select() })).status, 'assigned');
      await f.configure((source) => {
        Reflect.deleteProperty(source.github, 'issue-pickup');
        source.github['issue-assignment'].allowed = [
          { login: 'operator', 'node-id': 'U_operator' },
        ];
      });
      f.item.assignees.push({ login: 'collaborator', nodeId: 'U_collaborator', type: 'User' });
      await f.scan();
      await f.scan();
      const records = await f.read();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.evidence.mode, 'work');
      assert.equal(records[0]!.evidence.projectWork!.pickup!.assignmentNodeId, f.events[0]!.nodeId);
      assert.equal(f.effects.writes, 1);
    });

    it(`should apply a live milestone change without replacing native activation in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const before = await f.select();
      const beforeId = (await f.journal.read()).projectPickup!.operations[0]!.id;
      const enrollment = await f.enrollmentStore.read();
      await f.configure((source) => {
        source.github['issue-pickup'].projects[0]!.milestone!.number = 11;
        source.github['issue-pickup'].window = '90 minutes';
      });
      f.milestone.number = 11;
      f.milestone.nodeId = 'MI_next';
      f.item.milestone = { ...f.item.milestone!, number: 11, nodeId: 'MI_next' };
      await f.select();
      const afterId = (await f.journal.read()).projectPickup!.operations[0]!.id;
      assert.notEqual(afterId, beforeId);
      assert.equal((await f.pickup({ selection: before })).status, 'assigned');
      const current = (await f.journal.read()).projectPickup!;
      const operation = current.operations.find((op) => op.id === afterId)!;
      assert.equal(operation.enrollment?.milestoneNodeId, 'MI_next');
      assert.equal(operation.window.closesAt - operation.window.opensAt, 90 * 60000);
      assert.deepEqual(await f.enrollmentStore.read(), enrollment);
      assert.equal(f.effects.writes, 1);
      f.caller.current = false;
      await assert.rejects(f.pickup(), /native-caller-required/);
    });

    it(`should deliver candidate references without retaining large descriptions in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const original = structuredClone(f.item);
      f.items.clear();
      f.candidates.clear();
      for (let n = 1; n <= 5; n++) {
        f.items.set(n, { ...original, number: n, nodeId: `I_large_${n}` });
        f.candidates.set(n, {
          number: n,
          nodeId: `I_large_${n}`,
          title: `candidate ${n}`,
          body: `${n} quotes: " slash: \\ unicode: 🦊\n`.repeat(1500),
          labels: [],
        });
      }
      await f.pickup();
      const response = await f.pickup();
      assert.equal(response.status, 'selection-required');
      assert.equal(response.response, '');
      assert.ok(JSON.stringify(response).length < 16000);
      const restored = await hydrateImplementation(response, async ({ action, ...input }) => {
        assert.equal(action, 'pickup');
        const page = await f.pickup(input as PickupInput);
        assert.ok(JSON.stringify(page).length < 16000);
        return page;
      });
      assert.deepEqual(
        restored.candidates,
        [...f.candidates.values()].map((candidate) => ({
          ...omit(candidate, ['body']),
          url: `https://github.com/owner/repo/issues/${candidate.number}`,
          repository: 'owner/repo',
          pickupScope: 'only',
          blockedByOpenIssues: false,
        })),
      );
      assert.equal(f.effects.writes, 0);
      assert.equal('contextMaterials' in response, false);
      assert.ok(
        (await f.journal.read()).projectPickup!.operations[0]!.candidates.every(
          (candidate) => candidate.body === undefined,
        ),
      );
      f.caller.current = false;
      await assert.rejects(f.pickup(), /native-caller-required/);
      f.caller.current = true;
      const selection = {
        issueNodeId: 'I_large_5',
        rationale: 'ready work',
      };
      assert.equal((await f.pickup({ selection })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
      assert.equal((await f.journal.read()).projectPickup!.operations[0]!.candidates.length, 0);
      assert.equal((await f.pickup()).status, 'allowance-reached');
    });

    it(`should reference file guidance accepted at the shared limit in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const content = 'x'.repeat(32768);
      await writeFile(join(root, 'workspace', 'selection.md'), content);
      const response = await f.pickup();
      assert.equal(response.status, 'selection-required');
      const restored = await hydrateImplementation(response, async ({ action, ...input }) => {
        assert.equal(action, 'pickup');
        return f.pickup(input as PickupInput);
      });
      assert.equal('contextMaterials' in response, false);
      const guidance = restored.guidance as { path: string; content?: string };
      assert.equal(guidance.content, undefined);
      assert.equal(await readFile(guidance.path, 'utf8'), content);
      assert.equal((await f.journal.read()).projectPickup!.operations[0]!.guidance, content);
    });

    for (const editTail of [false, true]) {
      it(`should select a long description despite harmless later edits in ${runtime} with tail edit ${editTail}`, async () => {
        const f = await fixture(runtime);
        const candidate = f.candidates.get(f.item.number)!;
        let body = 'ready work\n'.repeat(6000);
        const provider = new GitHubIssuePickupClient(
          new GitHubWorkEventApiClient({
            identity: f.client.identity,
            execute: async () => ({
              exitCode: 0,
              timedOut: false,
              truncated: false,
              stderr: '',
              stdout: `HTTP/2 200 OK\n\n${JSON.stringify({
                item: {
                  ...f.item,
                  title: candidate.title,
                  isPullRequest: false,
                  milestone:
                    f.item.itemType === 'issue' && f.item.milestone
                      ? { ...f.item.milestone, node_id: f.item.milestone.nodeId }
                      : null,
                },
                candidate: { ...candidate, body },
              })}`,
            }),
          }),
        );
        f.client.projectCandidate = provider.projectCandidate.bind(provider);
        const selection = await f.select();
        const before = (await f.journal.read()).projectPickup!.operations[0]!.candidates[0]!;
        assert.equal(before.body, undefined);
        assert.equal(Object.hasOwn(before, 'bodyTruncated'), false);
        if (editTail) body += 'changed requirements';
        assert.equal((await f.pickup({ selection })).status, 'assigned');
        await f.scan();
        assert.equal((await f.read()).length, 1);
        assert.equal(f.effects.writes, 1);
      });
    }

    for (const lostResponse of [false, true]) {
      it(`should admit a write completed after window closure in ${runtime} with lost response ${lostResponse}`, async () => {
        const f = await fixture(runtime);
        const selection = await f.select();
        const window = (await f.journal.read()).projectPickup!.operations[0]!.window;
        f.clock.now = window.closesAt - 1000;
        const assign = f.client.assignProjectIssue;
        f.client.assignProjectIssue = async (...args) => {
          assert.ok(f.clock.now < window.closesAt);
          f.clock.now += 2000;
          await assign(...args);
          if (lostResponse) throw new Error('lost response');
        };
        assert.equal(
          (await f.pickup({ selection })).status,
          lostResponse ? 'attempted' : 'assigned',
        );
        f.tick.id = 'pickup-after-close';
        assert.equal((await f.pickup()).status, lostResponse ? 'assigned' : 'idle');
        await f.scan();
        await f.scan();
        const records = await f.read();
        assert.equal(records.length, 1);
        assert.equal(records[0]!.evidence.mode, 'work');
        assert.equal(f.effects.writes, 1);
        assert.ok(Date.parse(f.events[0]!.createdAt) > window.closesAt);
        const operation = (await f.journal.read()).projectPickup!.operations[0]!;
        assert.ok(operation.attemptedAt! < window.closesAt);
        assert.equal(operation.receipt!.assignmentNodeId, f.events[0]!.nodeId);
      });
    }

    it(`should admit newly available work on a later tick in the same window through ${runtime}`, async () => {
      const f = await fixture(runtime);
      const candidate = structuredClone(f.candidates.get(f.item.number)!);
      f.candidates.clear();
      assert.equal((await f.pickup()).status, 'empty');
      f.candidates.set(f.item.number, candidate);
      f.clock.now += 60000;
      f.tick.id = 'pickup-newly-available';
      assert.equal((await f.pickup({ selection: await f.select() })).status, 'assigned');
      await f.scan();
      await f.scan();
      assert.equal((await f.read()).length, 1);
      assert.equal(f.effects.writes, 1);
      assert.equal((await f.journal.read()).projectPickup!.operations.length, 1);
    });

    it(`should apply the live intake pool before writing through ${runtime}`, async () => {
      const f = await fixture(runtime, true);
      const selection = await f.select();
      await f.configure((source) => {
        source.github.routing = [
          {
            match: 'owner/*',
            workflows: ['issue-assignment'],
            target: { instances: ['11111111-1111-4111-8111-111111111111'] },
          },
          'owner/*',
        ];
      });
      const held = await f.pickup({ selection });
      assert.ok('code' in held && held.code === 'claim-route-instance-ineligible');
      assert.equal(f.effects.writes, 0);
      const identity = await f.claims!.store.identity();
      await f.configure((source) => {
        source.github.routing = [{ 'owner/*': [identity.instanceId] }];
      });
      assert.equal((await f.pickup({ selection: await f.select() })).status, 'assigned');
      assert.equal(f.claims!.effects.creates, 0);
      await f.scan();
      assert.equal((await f.read())[0]!.evidence.mode, 'work');
    });

    it(`should let ordinary intake elect an owner after pickup in ${runtime}`, async () => {
      const f = await fixture(runtime, true);
      await f.configure((source) => {
        source.github['issue-pickup'].start = '10:01';
        source.github['issue-pickup'].window = '1 minute';
        Reflect.set(source.github['issue-pickup'], 'scans', 1);
      });
      f.clock.now = baseline + 119000;
      assert.equal((await f.pickup({ selection: await f.select() })).status, 'assigned');
      assert.equal((await f.pickup()).status, 'allowance-reached');
      assert.equal(f.effects.writes, 1);
      assert.equal((await f.pickup()).status, 'allowance-reached');
      await f.scan();
      const records = await f.read();
      assert.equal(records.length, 1);
      const store = new AssignmentClaimStore(f.instanceRoot);
      const input = {
        intake: records[0]!,
        client: f.claims!.client.client,
        hasCapacity: true,
        mode: 'swarm' as const,
      };
      const ownership =
        runtime === 'codex'
          ? await new CodexAssignmentClaims(store, () => f.claims!.client).select({
              ...input,
              threadId: 'intake-thread',
              turnId: 'intake-turn',
            })
          : await new OpenClawAssignmentClaims(store, () => f.claims!.client).select({
              ...input,
              caller: {
                sessionKey: 'intake',
                sessionId: 'intake-session',
                runId: 'intake-run',
                toolCallId: 'intake-call',
              },
            });
      assert.equal(ownership.status, 'pending');
      assert.equal(f.claims!.effects.creates, 1);
      assert.equal(f.effects.writes, 1);
    });
    it(`should report every empty scheduled scan through ${runtime}`, async () => {
      const f = await fixture(runtime);
      f.candidates.clear();
      for (let index = 1; index <= 8; index++) {
        f.tick.id = `empty-scan-${index}`;
        const result = await f.pickup();
        assert.equal(result.status, 'empty');
        assert.match(result.response, /> ## 📥/);
        if (runtime === 'codex') assert.match(result.response, /<decision>NOTIFY<\/decision>/);
        assert.deepEqual((await f.journal.read()).projectPickup!.operations, []);
      }
      assert.equal(f.effects.writes, 0);
    });

    it(`should report uncertainty, confirmation and exhausted allowance through ${runtime}`, async () => {
      const f = await fixture(runtime);
      const assign = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await assign(...args);
        throw new Error('lost response');
      };
      const pending = await f.pickup({ selection: await f.select() });
      assert.match(pending.response, /> ## ⚠️/);
      const state = await f.journal.read();
      assert.equal(state.projectPickup!.operations[0]!.guidance, undefined);
      f.tick.id = 'confirm';
      const confirmed = await f.pickup();
      assert.equal(confirmed.status, 'assigned');
      assert.match(confirmed.response, /1 of 1 assigned/);
      f.tick.id = 'allowance';
      const exhausted = await f.pickup();
      assert.equal(exhausted.status, 'allowance-reached');
      assert.match(exhausted.response, /> ## 📥/);
      assert.equal(f.effects.writes, 1);
    });

    it(`should reject an expired native occurrence before provider assignment in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      f.caller.current = false;
      await assert.rejects(f.pickup({ selection }), /native-caller-required/);
      assert.equal(f.effects.writes, 0);
    });

    it(`should persist selection and uncertain assignment then admit once after restart in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      const before = await f.journal.read();
      assert.equal(before.projectPickup!.operations[0]!.guidance, 'prefer high impact ready work');
      assert.equal(before.projectPickup!.operations[0]!.phase, 'selecting');
      const write = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await write(...args);
        throw new Error('lost response');
      };
      assert.equal((await f.pickup({ selection })).status, 'attempted');
      assert.equal((await f.journal.read()).projectPickup!.operations[0]!.phase, 'attempted');
      f.clock.now += 7200000;
      assert.equal((await f.pickup()).status, 'assigned');
      await f.scan();
      await f.scan();
      const records = await f.read();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.evidence.mode, 'work');
      assert.equal(records[0]!.evidence.projectWork!.pickup!.assignmentNodeId, f.events[0]!.nodeId);
      assert.equal(f.effects.writes, 1);
      const state = await f.journal.read();
      const capacity =
        runtime === 'codex'
          ? codexCapacity([], 1, state.projectPickup)
          : openClawCapacity([], 1, state.projectPickup);
      assert.deepEqual(capacity, { occupied: 0, available: 1 });
    });

    it(`should withhold an uncertain self-assignment even when the actor is approved in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      const write = f.client.assignProjectIssue;
      f.client.assignProjectIssue = async (...args) => {
        await write(...args);
        throw new Error('lost response');
      };
      await f.pickup({ selection });
      await f.scan();
      assert.equal((await f.read()).length, 0);
      await f.pickup();
      await f.scan();
      assert.equal((await f.read()).length, 1);
    });

    it(`should serialize concurrent ticks and preserve the assignment for intake in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const selection = await f.select();
      const results = await Promise.allSettled([f.pickup({ selection }), f.pickup({ selection })]);
      assert.ok(
        results.some(
          (result) => result.status === 'fulfilled' && result.value.status === 'assigned',
        ),
      );
      assert.equal(f.effects.writes, 1);
      const attempted = (await f.journal.read()).projectPickup!.operations[0]!;
      assert.equal((await f.pickup({ cancel: attempted.id })).status, 'allowance-reached');
      await f.scan();
      assert.equal((await f.read()).length, 1);
      f.tick.id = 'next-scan';
      assert.equal((await f.pickup()).status, 'allowance-reached');
    });

    it(`should refuse reassignment away from the receiver before native admission in ${runtime}`, async () => {
      const f = await fixture(runtime);
      await f.pickup({ selection: await f.select() });
      f.item.assignees = [{ login: 'other', nodeId: 'U_other', type: 'User' }];
      await f.scan();
      assert.equal((await f.read()).length, 0);
      assert.equal(f.item.assignees.length, 1);
    });
  }
});
