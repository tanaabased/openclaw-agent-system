import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import DiscoveryBudget from '../agent/discovery-budget.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { omit } from 'lodash-es';

import IntakeRecordStore, {
  IntakeError,
  intakeLocation,
} from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

describe('channels/github/intake/records', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intake-records-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  function setup(runtime: 'codex' | 'openclaw' = 'codex') {
    const fixture = intakeFixture();
    const location = intakeLocation({
      runtime,
      root,
      namespace: '/profile',
      workspaceDir: '/workspace',
      agentId: 'receiver',
    });
    const store = new IntakeRecordStore(location);
    return {
      ...fixture,
      store,
      input: {
        store,
        policy: fixture.policy,
        policyDigest: 'approved-policy',
        workspaceDir: '/workspace',
        agentId: 'receiver',
        now: baseline,
        connect: async () => fixture.client,
        assertCurrent: async () => {},
      },
    };
  }
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should exclude one repository without blocking another ${runtime} candidate`, async () => {
      const { input, client, store, policy, repository, events } = setup(runtime);
      policy.routing = ['!owner/excluded', 'owner/*'];
      const assignments = events.splice(0);
      await scanAssignments({ ...input, activate: true });
      events.push(...assignments);
      const discover = client.discoverAssigned;
      client.discoverAssigned = async (...args) => {
        const found = await discover(...args);
        return {
          ...found,
          totalCount: 2,
          candidates: [
            { ...found.candidates[0]!, repositoryPath: '/repos/owner/excluded' },
            ...found.candidates,
          ],
        };
      };
      client.getRepository = async (_owner, name) => ({ ...repository, name });
      const result = await scanAssignments({ ...input, now: baseline + 120000 });
      assert.equal(result.admitted, 1);
      assert.deepEqual(
        result.repositoryScope?.map(({ reason, count }) => [reason, count]),
        [
          ['excluded', 1],
          ['match', 1],
        ],
      );
      assert.equal((await store.read())!.records[0]!.repository.name, 'repo');
    });

    it(`should apply ordered ${runtime} routing to fresh canonical names and preserve admitted work`, async () => {
      const { input, store, policy, repository } = setup(runtime);
      policy.routing = ['!owner/repo', 'owner/*'];
      await scanAssignments({ ...input, activate: true });
      const excluded = await scanAssignments({ ...input, now: baseline + 120000 });
      assert.equal(excluded.admitted, 0);
      assert.deepEqual(excluded.repositoryScope, [
        {
          source: 'routing',
          decision: 'deny',
          reason: 'excluded',
          index: 0,
          pattern: '!owner/repo',
          count: 1,
        },
      ]);
      policy.routing = ['owner/renamed'];
      const miss = await scanAssignments({ ...input, now: baseline + 180000 });
      assert.equal(miss.repositoryScope![0]!.reason, 'no-match');
      // the search path still uses the old name; the provider redirects to the current name.
      repository.name = 'renamed';
      const included = await scanAssignments({ ...input, now: baseline + 240000 });
      assert.equal(included.admitted, 1);
      const saved = (await store.read())!;
      assert.equal(saved.records[0]!.repository.name, 'renamed');
      assert.equal(saved.records[0]!.evidence.ownerPinned, false);
      assert.equal(saved.records[0]!.evidence.repositoryScope!.pattern, 'owner/renamed');
      policy.routing = [];
      await scanAssignments({ ...input, now: baseline + 300000 });
      assert.deepEqual((await store.read())!.records, saved.records);
      assert.equal((await store.read())!.baselineAt, saved.baselineAt);
      policy.routing = ['owner/*'];
      const resumed = await scanAssignments({
        ...input,
        store: new IntakeRecordStore(store.location),
        now: baseline + 360000,
      });
      assert.equal(resumed.admitted, 0);
      assert.deepEqual((await store.read())!.records, saved.records);
    });

    it(`should remove only duplicate admitted observations under ${runtime} byte pressure`, async () => {
      const { input, store, events } = setup(runtime);
      const assigned = events.splice(0);
      await scanAssignments({ ...input, activate: true });
      events.push(...assigned);
      await scanAssignments({ ...input, now: baseline + 120000 });
      const admitted = (await store.read())!.records[0]!;
      const observed = omit(admitted, ['evidence', 'admittedAt', 'status', 'requiresRevalidation']);
      const unevaluated = { ...observed, id: 'unadmitted-assignment' };
      await store.exclusive(async (state, save) => {
        state!.observedAssignments = [
          ...Array.from(
            {
              length:
                Math.ceil((2 * 1024 * 1024) / Buffer.byteLength(JSON.stringify(observed))) + 1,
            },
            () => structuredClone(observed),
          ),
          unevaluated,
        ];
        assert.ok(Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024);
        await save(state!);
        assert.deepEqual(state!.observedAssignments, [unevaluated]);
      });
      const saved = (await new IntakeRecordStore(store.location).read())!;
      assert.deepEqual(saved.records, [admitted]);
      assert.deepEqual(saved.observedAssignments, [unevaluated]);
      assert.equal((await scanAssignments({ ...input, now: baseline + 180000 })).admitted, 0);
      assert.equal((await store.read())!.baselineAt, saved.baselineAt);
    });

    it(`should resolve compact ${runtime} policy before owner filtering and assignment admission`, async () => {
      const { input, store, policy, client, events, repository } = setup(runtime);
      policy.allowedRepositoryOwners = [
        { login: '', nodeId: repository.owner.nodeId, reference: repository.owner.nodeId },
      ];
      policy.issueAssignment!.allowed = [{ login: 'receiver', nodeId: '', reference: '@receiver' }];
      client.resolveIdentity = async (reference) =>
        reference === repository.owner.nodeId ? repository.owner : client.identity;
      const assigned = events.splice(0);
      await scanAssignments({ ...input, activate: true });
      events.push(...assigned);
      const result = await scanAssignments({ ...input, now: baseline + 120000 });
      assert.equal(result.admitted, 1);
      const record = (await store.read())!.records[0]!;
      assert.equal(record.repository.owner.nodeId, repository.owner.nodeId);
      assert.equal(record.assignment.actor.nodeId, client.identity.nodeId);
      assert.equal((await scanAssignments({ ...input, now: baseline + 180000 })).admitted, 0);
    });
  }
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should upgrade unchanged ${runtime} legacy policy during normal intake without duplicating admissions`, async () => {
      const { input, store } = setup(runtime);
      await scanAssignments({ ...input, activate: true, now: baseline + 120000 });
      const before = (await store.read())!;
      const next = {
        ...input,
        policyDigest: 'canonical',
        now: baseline + 180000,
      };
      await scanAssignments(next);
      const after = (await store.read())!;
      assert.equal(after.policyDigest, 'canonical');
      assert.equal(after.baselineAt, before.baselineAt);
      assert.deepEqual(
        after.records.map(({ id }) => id),
        before.records.map(({ id }) => id),
      );
      assert.equal((await scanAssignments({ ...next, policyDigest: 'changed' })).status, 'ready');
      assert.equal((await store.read())!.baselineAt, before.baselineAt);
    });
  }
  it('should admit only the selected issue without searching or advancing the global checkpoint', async () => {
    const { input, store, client, item, events } = setup('openclaw');
    const assigned = events.splice(0);
    await scanAssignments({ ...input, activate: true });
    events.push(...assigned);
    const checkpoint = (await store.read())!.checkpoint;
    const fetched: number[] = [];
    client.discoverAssigned = async () => {
      throw Error('targeted intake must not search');
    };
    client.getItem = async (owner, repo, number) => {
      assert.equal(owner, 'owner');
      assert.equal(repo, 'repo');
      fetched.push(number);
      return { ...item, number, nodeId: `I_${number}`, databaseId: number };
    };
    for (const number of [3, 4]) {
      const result = await scanAssignments({
        ...input,
        now: baseline + 120000,
        selector: { itemType: 'issue', repository: 'owner/repo', number },
      });
      assert.equal(result.admitted, 1);
      assert.deepEqual(
        (await store.read())!.records.map((record) => record.issue.number),
        number === 3 ? [3] : [3, 4],
      );
      assert.equal((await store.read())!.checkpoint, checkpoint);
    }
    assert.deepEqual(fetched, [3, 4]);
  });

  it('should reconsider a policy hold immediately after intake is reenabled', async () => {
    const { input, store, events } = setup();
    const assigned = events.splice(0);
    await scanAssignments({ ...input, activate: true });
    events.push(...assigned);
    const held = await scanAssignments({
      ...input,
      now: baseline + 120000,
      readPolicy: async () => {
        input.policy.issueAssignment!.paused = true;
        throw new IntakeError('intake-policy-disabled');
      },
    });
    assert.equal(held.code, 'intake-policy-disabled');
    input.policy.issueAssignment!.paused = false;
    const resumed = await scanAssignments({ ...input, now: baseline + 120001 });
    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.admitted, 1);
    assert.equal((await store.read())!.blocker, undefined);
  });

  it('should retain unapproved assignments and admit them after a live policy update without activation', async () => {
    const { input, store, events } = setup();
    const assigned = events.splice(0);
    await scanAssignments({ ...input, activate: true });
    events.push(...assigned);
    const approved = input.policy.issueAssignment!.allowed;
    input.policy.issueAssignment!.allowed = [];
    assert.equal((await scanAssignments({ ...input, now: baseline + 120000 })).admitted, 0);
    const held = (await store.read())!;
    assert.equal(held.records.length, 0);
    assert.equal(held.observedAssignments?.length, 1);
    input.policy.issueAssignment!.allowed = approved;
    assert.equal(
      (await scanAssignments({ ...input, policyDigest: 'live-update', now: baseline + 180000 }))
        .admitted,
      1,
    );
    const resumed = (await store.read())!;
    assert.equal(resumed.baselineAt, held.baselineAt);
    assert.equal(resumed.records[0]!.id, held.observedAssignments![0]!.id);
    assert.equal((await scanAssignments({ ...input, now: baseline + 240000 })).admitted, 0);
  });

  it('should still require assignment, actor and owner authorization for selected intake', async () => {
    const { input, store, client, item, events, repository } = setup('openclaw');
    const assigned = events.splice(0);
    await scanAssignments({ ...input, activate: true });
    events.push(...assigned);
    client.discoverAssigned = async () => {
      throw Error('targeted intake must not search');
    };
    const selected = {
      ...input,
      now: baseline + 120000,
      selector: { itemType: 'issue' as const, repository: 'owner/repo', number: 3 },
    };
    const assignees = item.assignees;
    item.assignees = [];
    assert.equal((await scanAssignments(selected)).admitted, 0);
    item.assignees = assignees;
    const actor = events[0]!.actor;
    events[0]!.actor = { ...actor, nodeId: 'unapproved' };
    assert.equal((await scanAssignments(selected)).admitted, 0);
    events[0]!.actor = actor;
    repository.owner = { ...repository.owner, nodeId: 'unpinned' };
    assert.equal((await scanAssignments(selected)).admitted, 0);
    assert.deepEqual((await store.read())!.records, []);
  });

  it('should preserve a filesystem denial during scan persistence without recording a provider failure', async () => {
    const { input, store } = setup();
    await scanAssignments({ ...input, activate: true });
    const before = await store.read();
    for (const code of ['EPERM', 'EACCES']) {
      const denial = Object.assign(new Error('denied'), { code });
      store.file.write = async () => {
        throw denial;
      };
      await assert.rejects(
        scanAssignments({ ...input, now: baseline + 120000 }),
        (error: unknown) => error === denial,
      );
      assert.deepEqual(await store.read(), before);
    }
  });
  it('should refresh repository scope while resuming completed issue observations after its budget expires', async () => {
    const { input, store, client, events } = setup('openclaw');
    const assignments = events.splice(0);
    await scanAssignments({ ...input, activate: true });
    events.push(...assignments);
    let clock = 0;
    let reads = 0;
    const read = client.getRepository;
    client.getRepository = async (...args) => {
      reads++;
      return read(...args);
    };
    const readItem = client.getItem;
    let itemReads = 0;
    client.getItem = async (...args) => {
      itemReads++;
      clock = 20000;
      return readItem(...args);
    };
    const partial = await scanAssignments({
      ...input,
      now: baseline + 120000,
      budget: new DiscoveryBudget(20000, undefined, () => clock),
    });
    assert.equal(partial.more, true);
    assert.equal(partial.status, 'ready');
    const saved = (await store.read())!;
    assert.equal(saved.baselineAt, baseline);
    assert.equal(saved.records.length, 0);
    assert.ok(saved.discovery?.observations?.issue);
    clock = 0;
    const complete = await scanAssignments({
      ...input,
      store: new IntakeRecordStore(store.location),
      now: baseline + 240000,
      budget: new DiscoveryBudget(20000, undefined, () => clock),
    });
    assert.equal(complete.admitted, 1);
    assert.equal(reads, 2);
    assert.equal(itemReads, 1);
    assert.equal((await store.read())!.records.length, 1);
  });

  it('should propagate local save failures without inventing a provider outage', async () => {
    const { input, store } = setup();
    await scanAssignments({ ...input, activate: true });
    const before = await store.read();
    const failure = new Error('local persistence failed');
    let writes = 0;
    store.file.write = async () => {
      writes++;
      throw failure;
    };
    await assert.rejects(scanAssignments(input), (error: unknown) => error === failure);
    assert.equal(writes, 1);
    assert.deepEqual(await store.read(), before);
  });
  it('should require activation and persist one immutable record across polls and restart for both host mappings', async () => {
    for (const runtime of ['codex', 'openclaw'] as const) {
      const { input, store, events } = setup(runtime);
      await assert.rejects(scanAssignments(input), { code: 'intake-activation-required' });
      const future = events[0]!.createdAt;
      events[0]!.createdAt = new Date(baseline - 1000).toISOString();
      await scanAssignments({ ...input, activate: true });
      assert.equal((await store.read())!.records.length, 0);
      events[0]!.createdAt = future;
      const accepted = await scanAssignments({ ...input, now: baseline + 120_000 });
      assert.ok('admitted' in accepted);
      assert.equal(accepted.admitted, 1);
      const state = (await store.read())!;
      assert.equal(state.records[0]!.assignment.nodeId, 'E_assignment');
      assert.equal(state.records[0]!.assignment.actor.nodeId, 'U_receiver');
      assert.equal(state.records[0]!.requiresRevalidation, true);
      assert.equal(state.records[0]!.evidence.mode, 'plan');
      const restarted = new IntakeRecordStore(store.location);
      const repeated = await scanAssignments({
        ...input,
        store: restarted,
        now: baseline + 180_000,
      });
      assert.equal(repeated.changed, false);
      assert.equal((await restarted.read())!.records.length, 1);
      assert.equal((await restarted.read())!.baselineAt, baseline);
    }
  });
  it('should reject unauthorized actors, owner pin mismatches, closed and unassigned issues, bots, and old events', async () => {
    const cases = [
      (f: ReturnType<typeof setup>) => {
        f.events[0]!.actor = { login: 'stranger', nodeId: 'U_stranger', type: 'User' };
      },
      (f: ReturnType<typeof setup>) => {
        f.repository.owner = { login: 'owner', nodeId: 'O_other', type: 'Organization' };
      },
      (f: ReturnType<typeof setup>) => {
        f.item.state = 'closed';
      },
      (f: ReturnType<typeof setup>) => {
        f.item.assignees = [];
      },
      (f: ReturnType<typeof setup>) => {
        f.events[0]!.actor = { ...f.events[0]!.actor, type: 'Bot' };
      },
      (f: ReturnType<typeof setup>) => {
        f.events[0]!.createdAt = new Date(baseline).toISOString();
      },
      (f: ReturnType<typeof setup>) => {
        f.events.push({
          ...f.events[0]!,
          event: 'unassigned',
          databaseId: 31,
          nodeId: 'E_removed',
        });
      },
    ];
    for (const change of cases) {
      const fixture = setup();
      change(fixture);
      await scanAssignments({ ...fixture.input, activate: true });
      assert.equal((await fixture.store.read())!.records.length, 0);
    }
  });
  for (const failure of ['history', 'identity', 'permission', 'missing'] as const) {
    it(`should defer an issue with ${failure} failure and admit unrelated work before retrying after restart`, async () => {
      const { input, client, store, events, item } = setup();
      const assigned = events.splice(0);
      await scanAssignments({ ...input, activate: true });
      events.push(...assigned);
      let broken = true;
      let search = true;
      const candidate = (number: number) => ({
        repositoryPath: '/repos/owner/repo',
        itemType: 'issue' as const,
        updatedAt: item.updatedAt,
        number,
        nodeId: `I_${number}`,
        databaseId: number,
      });
      client.discoverAssigned = async () => ({
        candidates: search ? [candidate(3), candidate(4)] : [],
        totalCount: search ? 2 : 0,
        incomplete: false,
        truncated: false,
      });
      client.getItem = async (_owner, _repo, number) => {
        if (broken && number === 3 && ['permission', 'missing'].includes(failure))
          throw new GitHubWorkEventClientError(
            'github-denied',
            'denied',
            {},
            undefined,
            providerDiagnostic(
              'github',
              'api-request',
              failure === 'missing' ? 'unknown' : 'permission',
              { httpStatus: failure === 'missing' ? 404 : 403 },
            ),
          );
        return {
          ...item,
          number,
          databaseId: number,
          nodeId: broken && number === 3 && failure === 'identity' ? 'wrong' : `I_${number}`,
        };
      };
      client.listAssignmentEvents = async (_owner, _repo, number) => ({
        events,
        truncated: broken && number === 3 && failure === 'history',
      });
      const first = await scanAssignments({ ...input, now: baseline + 10000 });
      assert.equal(first.status, 'ready');
      assert.equal(first.admitted, 1);
      const held = (await store.read())!;
      assert.deepEqual(
        held.records.map((entry) => entry.issue.number),
        [4],
      );
      assert.equal(held.deferred?.length, 1);
      assert.equal(held.blocker, undefined);
      assert.equal(held.checkpoint, baseline + 10000);
      const again = await scanAssignments({ ...input, now: baseline + 11000 });
      assert.equal(again.changed, false);
      broken = false;
      search = false;
      const resumed = await scanAssignments({
        ...input,
        store: new IntakeRecordStore(store.location),
        now: baseline + 12000,
      });
      assert.equal(resumed.status, 'ready');
      assert.equal(resumed.admitted, 1);
      const after = (await store.read())!;
      assert.deepEqual(
        after.records.map((entry) => entry.issue.number),
        [4, 3],
      );
      assert.deepEqual(after.deferred, []);
      assert.equal(after.baselineAt, baseline);
    });
  }

  for (const classification of ['authentication', 'rate-limit', 'transport'] as const) {
    it(`should retain scan-wide backoff for ${classification} failures`, async () => {
      const { input, client, store } = setup();
      await scanAssignments({ ...input, activate: true });
      client.getItem = async () => {
        throw new GitHubWorkEventClientError(
          'github-failed',
          'failed',
          {},
          undefined,
          providerDiagnostic('github', 'api-request', classification),
        );
      };
      const result = await scanAssignments({ ...input, now: baseline + 10000 });
      assert.equal(result.status, 'blocked');
      assert.equal(result.code, `intake-github-${classification}`);
      assert.equal((await store.read())!.deferred, undefined);
      assert.equal((await store.read())!.blocker?.retryAfter, baseline + 310000);
      assert.equal(
        (await store.read())!.blocker?.providerDiagnostic?.classification,
        classification,
      );
    });
  }

  it('should serialize overlapping store instances and refuse commits after policy changes', async () => {
    const { input, store, events } = setup();
    events[0]!.createdAt = new Date(baseline - 1).toISOString();
    await scanAssignments({ ...input, activate: true });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scanAssignments({
      ...input,
      now: baseline + 1000,
      assertCurrent: async () => {
        entered();
        await gate;
      },
    });
    await ready;
    await assert.rejects(
      scanAssignments({ ...input, store: new IntakeRecordStore(store.location) }),
      { code: 'private-state-file-lock-busy' },
    );
    release();
    await first;
    const before = (await store.read())!.checkpoint;
    const failed = await scanAssignments({
      ...input,
      now: baseline + 2000,
      assertCurrent: async () => {
        throw new Error('changed');
      },
    });
    assert.equal(failed.status, 'blocked');
    assert.equal((await store.read())!.checkpoint, before);
  });
  it('should preserve corrupt evidence and reject identity or policy changes', async () => {
    const { input, store } = setup();
    await scanAssignments({ ...input, activate: true });
    assert.equal((await scanAssignments({ ...input, policyDigest: 'updated' })).status, 'ready');
    await writeFile(store.location.path, '{broken', { mode: 0o600 });
    await assert.rejects(scanAssignments(input), { code: 'intake-state-invalid' });
    assert.equal(await readFile(store.location.path, 'utf8'), '{broken');
  });
});
