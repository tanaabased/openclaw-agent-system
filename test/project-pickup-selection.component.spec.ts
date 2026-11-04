import type { RepositoryRoute } from '../channels/github/repository-scope.ts';
import AssignmentClaimStore from '../agent/assignment-claim-store.ts';
import ProjectPickupEnrollmentStore from '../agent/project-pickup-enrollment.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import codexCapacity from '../agent/codex-capacity.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import {
  prepareCodexPickupEnrollment,
  runCodexIntake,
  runCodexProjectPickup,
  selectCodexIntake,
  type CodexIntakeDependencies,
} from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import openClawCapacity from '../agent/openclaw-capacity.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import { projectPickupPolicyDigest } from '../agent/project-pickup-authority.ts';
import type { PickupInput } from '../agent/project-pickup.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import parseAgentManifest from '../manifest/parse.ts';
import { baseline } from './github-intake-fixture.ts';
import selectionFixture from './project-pickup-selection-fixture.ts';
import pickupClaims from './project-pickup-claim-fixture.ts';
import CodexAssignmentClaims from '../agent/codex-assignment-claims.ts';
import OpenClawAssignmentClaims from '../agent/openclaw-assignment-claims.ts';
import GitHubProjectPickupClient from '../channels/github/provider/project-pickup-client.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

describe('project pickup selection through native journals', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pickup-selection-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(runtime: 'codex' | 'openclaw', coordinated = false) {
    const f = selectionFixture(runtime);
    const workspace = join(root, 'workspace');
    const data = join(root, 'data');
    const home = join(root, 'codex');
    await mkdir(workspace);
    await mkdir(home);
    const instanceRoot = join(data, 'instance');
    await new AssignmentClaimStore(instanceRoot).identity();
    const enrollmentStore = new ProjectPickupEnrollmentStore(instanceRoot);
    const caller = { current: true };
    const tick = { id: 'pickup-turn-1' };
    const claims = coordinated ? pickupClaims(f, instanceRoot) : undefined;
    const assertCurrent = async () => {
      if (!caller.current) throw new Error('project-pickup-native-caller-required');
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
      agent: { id: 'receiver' },
      github: {
        username: 'receiver',
        runtimes: [runtime],
        ...(coordinated ? { routing: [{ 'owner/*': 'swarm' }] as RepositoryRoute[] } : {}),
        'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
        'max-concurrent-items': 1,
        'issue-assignment': {
          mode: 'plan',
          allowed: [
            { login: 'operator', 'node-id': 'U_operator' },
            { login: 'receiver', 'node-id': 'U_receiver' },
          ],
        },
        'project-pickup': {
          start: '10:00',
          window: '1 hour',
          selection: { guidance: { file: 'selection.md' } },
          projects: [
            { repository: 'owner/repo', milestone: { number: 10, policy: 'only' }, limit: 1 },
          ],
        },
      },
    };
    const source = JSON.stringify(declaration);
    await writeFile(join(workspace, 'agent.yaml'), source);
    await writeFile(join(workspace, 'selection.md'), 'prefer high impact ready work');
    const parsed = parseAgentManifest(source);
    assert.equal(parsed.status, 'valid');
    if (parsed.status !== 'valid') throw new Error('fixture invalid');
    const manifest = parsed.manifest;
    f.clock.now = baseline;
    let pickup: (input?: PickupInput) => ReturnType<typeof runCodexProjectPickup>;
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
        connect: async () => f.client,
        threadId: 'pickup-thread',
        pickupActivation: async () => ({ threadId: 'pickup-thread', nativeId: 'pickup-job' }),
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
      const selected = await selectCodexIntake(data, deps);
      scope = selected.store.location.scope;
      journal = new CodexDispatchStore(data, scope);
      const enrollment = await prepareCodexPickupEnrollment(data, deps);
      await enrollmentStore.activate(enrollment.enrollment.id, occurrence.nativeId);
      Object.assign(f.authority.enrollment, enrollment.enrollment);
      pickup = (input = {}) => runCodexProjectPickup(data, input, 'UTC', deps);
      scan = () => runCodexIntake(data, false, deps);
      read = async () => (await selected.store.read())!.records;
    } else {
      const intake = new OpenClawIntake({
        root: data,
        pickupStore: enrollmentStore,
        namespace: root,
        now: () => f.clock.now,
        readiness: async () => undefined,
        connect: async () => f.client,
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
      policyDigest: projectPickupPolicyDigest(manifest.github!.notifications!),
    });
    f.clock.now += 60000;
    const select = async () => {
      const result = await pickup();
      assert.equal(result.status, 'selection-required');
      assert.ok('digest' in result);
      return {
        id: result.id!,
        digest: result.digest!,
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
    };
  }

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should reconcile a removed repository and retain its allowance across live limits in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const other = f.addRepository('other', 2);
      const project = {
        repository: 'owner/other',
        milestone: { number: 10, policy: 'only' },
        limit: 2,
      };
      const before = await f.enrollmentStore.read();
      await f.configure((source) => source.github['project-pickup'].projects.push(project));
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
      await f.configure((source) => source.github['project-pickup'].projects.pop());
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
        source.github['project-pickup'].projects.push({ ...project, limit: 1 }),
      );
      f.tick.id = 'lowered-limit';
      const lower = await f.pickup();
      assert.equal(lower.status, 'selection-required');
      assert.ok(
        'candidates' in lower &&
          lower.candidates?.every((entry) => entry.repository !== 'owner/other'),
      );
      await f.configure((source) => {
        source.github['project-pickup'].projects[1]!.limit = 2;
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
          id: raised.id,
          digest: raised.digest,
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
      const selection = await f.select();
      const path = join(root, 'workspace', 'selection.md');
      await writeFile(path, 'prefer release blockers');
      f.tick.id = 'later-native-run';
      const fresh = await f.pickup();
      assert.equal(fresh.status, 'selection-required');
      assert.ok('guidance' in fresh && 'digest' in fresh);
      assert.equal(fresh.guidance, 'prefer release blockers');
      assert.notEqual(fresh.digest, selection.digest);
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

    it(`should invalidate material from the old guidance snapshot in ${runtime}`, async () => {
      const f = await fixture(runtime);
      f.candidates.get(f.item.number)!.body = 'candidate details '.repeat(2000);
      const first = await f.pickup();
      assert.ok('contextMaterials' in first && first.contextMaterials);
      const { action, ...input } = first.contextMaterials.fields[0]!.request;
      assert.equal(action, 'pickup');
      await writeFile(join(root, 'workspace', 'selection.md'), 'changed selection priorities');
      f.tick.id = 'new-scan';
      await assert.rejects(f.pickup(input as PickupInput), /selection-stale/);
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
        Reflect.deleteProperty(source.github, 'project-pickup');
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
      const enrollment = await f.enrollmentStore.read();
      await f.configure((source) => {
        source.github['project-pickup'].projects[0]!.milestone.number = 11;
        source.github['project-pickup'].window = '90 minutes';
      });
      f.milestone.number = 11;
      f.milestone.nodeId = 'MI_next';
      f.item.milestone = { ...f.item.milestone!, number: 11, nodeId: 'MI_next' };
      const after = await f.select();
      assert.notEqual(after.id, before.id);
      assert.equal((await f.pickup({ selection: before })).status, 'failed');
      const refreshed = await f.select();
      assert.equal((await f.pickup({ selection: refreshed })).status, 'assigned');
      const current = (await f.journal.read()).projectPickup!;
      const operation = current.operations.find((op) => op.id === after.id)!;
      assert.equal(operation.enrollment?.milestoneNodeId, 'MI_next');
      assert.equal(operation.window.closesAt - operation.window.opensAt, 90 * 60000);
      assert.deepEqual(await f.enrollmentStore.read(), enrollment);
      assert.equal(f.effects.writes, 1);
      f.caller.current = false;
      await assert.rejects(f.pickup(), /native-caller-required/);
    });

    it(`should deliver complete large candidate material through authorized pages in ${runtime}`, async () => {
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
          ...candidate,
          repository: 'owner/repo',
          blockedByOpenIssues: false,
        })),
      );
      assert.equal(f.effects.writes, 0);
      assert.ok('contextMaterials' in response && response.contextMaterials);
      const request = response.contextMaterials.fields[0]!.request;
      const { action, ...input } = request;
      assert.equal(action, 'pickup');
      const materialInput = input as PickupInput;
      await assert.rejects(
        f.pickup({
          ...materialInput,
          context: { id: 'other-operation', digest: String(restored.digest) },
        }),
        /selection-stale/,
      );
      await assert.rejects(
        f.pickup({
          ...materialInput,
          material: { ...materialInput.material!, digest: 'a'.repeat(64) },
        }),
        /material-stale/,
      );
      assert.equal((await f.journal.read()).projectPickup!.operations[0]!.phase, 'selecting');
      f.caller.current = false;
      await assert.rejects(f.pickup(input as PickupInput), /native-caller-required/);
      f.caller.current = true;
      const selection = {
        id: String(restored.id),
        digest: String(restored.digest),
        issueNodeId: 'I_large_5',
        rationale: 'ready work',
      };
      assert.equal((await f.pickup({ selection })).status, 'assigned');
      assert.equal(f.effects.writes, 1);
      assert.equal((await f.journal.read()).projectPickup!.operations[0]!.candidates.length, 0);
      assert.equal((await f.pickup(input as PickupInput)).status, 'allowance-reached');
    });

    it(`should page temporary guidance accepted at the shared limit in ${runtime}`, async () => {
      const f = await fixture(runtime);
      const content = 'x'.repeat(32768);
      await writeFile(join(root, 'workspace', 'selection.md'), content);
      const response = await f.pickup();
      assert.equal(response.status, 'selection-required');
      const restored = await hydrateImplementation(response, async ({ action, ...input }) => {
        assert.equal(action, 'pickup');
        return f.pickup(input as PickupInput);
      });
      assert.equal(restored.guidance, content);
      assert.equal((await f.journal.read()).projectPickup!.operations[0]!.guidance, content);
    });

    for (const editTail of [false, true]) {
      it(`should select a long description despite harmless later edits in ${runtime} with tail edit ${editTail}`, async () => {
        const f = await fixture(runtime);
        const candidate = f.candidates.get(f.item.number)!;
        let body = 'ready work\n'.repeat(6000);
        const provider = new GitHubProjectPickupClient(
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
        assert.equal(before.body, body);
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
        source.github['project-pickup'].start = '10:01';
        source.github['project-pickup'].window = '1 minute';
        Reflect.set(source.github['project-pickup'], 'scans', 1);
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
      assert.equal((await f.pickup({ cancel: selection.id })).status, 'allowance-reached');
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
