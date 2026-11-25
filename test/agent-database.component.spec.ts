import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import {
  pickupDispatchScope,
  sqliteDispatchPersistence,
} from '../agent/storage/dispatch-backend.ts';
import OpenClawDispatchStore from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import { bindSqliteStorage } from '../agent/storage/agent-database.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';
import { account, baseline, intakeFixture } from './github-intake-fixture.ts';

const schemaRoot = fileURLToPath(new URL('../agent/storage/', import.meta.url));

function bind(root: string, agentId: string, schemas = schemaRoot) {
  return bindSqliteStorage(
    {
      agentRoot: join(root, 'agents'),
      installationRoot: join(root, 'instance'),
      schemaRoot: schemas,
    },
    agentId,
  );
}

function sampleIntake(agentId: string, checkpoint: number): IntakeState {
  const { repository, item, events } = intakeFixture();
  const workspaceDir = '/work/' + agentId;
  const scope = 'same-scope';
  return {
    version: 1,
    scope,
    agentId,
    workspaceDir,
    account,
    policyDigest: 'policy',
    baselineAt: baseline,
    checkpoint,
    records: [
      {
        version: 1,
        id: 'same-record',
        scope,
        workspaceDir,
        agentId,
        receiving: account,
        host: 'github.com',
        repository,
        issue: item,
        assignment: { ...events[0]!, event: 'assigned', actor: account, assignee: account },
        evidence: {
          policyDigest: 'policy',
          mode: 'plan',
          open: true,
          assigned: true,
          repositoryReadable: true,
          ownerPinned: true,
          actorPinned: true,
        },
        observedAt: baseline,
        admittedAt: checkpoint,
        status: 'admitted',
        requiresRevalidation: true,
      },
    ],
  };
}

function saveIntake(agent: ReturnType<typeof bind>['agent'], state: IntakeState) {
  return agent.changeIntake(state.scope, false, () => ({ state, result: undefined }));
}

describe('agent database', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-storage-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should keep two codex installs independent even with the same agent, workspace and record ids', async () => {
    const laptopA = bind(join(root, 'laptop-a'), 'pirog');
    const laptopB = bind(join(root, 'laptop-b'), 'pirog');
    const a = sampleIntake('pirog', baseline + 1);
    const b = sampleIntake('pirog', baseline + 2);
    await assert.rejects(laptopA.agent.readIntake(a.scope), { code: 'ENOENT' });
    assert.match((await laptopA.agent.inspect()).message, /`pirog\.sqlite`/);
    assert.match((await laptopA.installation.inspect()).message, /`agent-system\.sqlite`/);
    await laptopA.agent.install();
    await laptopB.agent.install();
    await saveIntake(laptopA.agent, a);
    await saveIntake(laptopB.agent, b);
    assert.deepEqual(await laptopA.agent.readIntake(a.scope), a);
    await laptopA.agent.clearIntake(a.scope);
    assert.equal(await laptopA.agent.readIntake(a.scope), undefined);
    assert.equal((await laptopB.agent.install()).status, 'unchanged');
    assert.deepEqual(await laptopB.agent.readIntake(b.scope), b);
    await laptopA.installation.install();
    await laptopB.installation.install();
    const repo = {
      version: 1 as const,
      repositoryId: 'repo',
      source: 'origin',
      path: '/work/repo',
    };
    await laptopA.installation.saveRepository('/work', repo);
    assert.equal(await laptopB.installation.readRepository('/work', repo.repositoryId), undefined);
  });

  it('should share installation records between openclaw agents and keep their intake private', async () => {
    const emori = bind(root, 'emori');
    const smutlord = bind(root, 'smutlord');
    const state = sampleIntake('emori', baseline + 1);
    for (const store of [emori, smutlord]) await store.agent.install();
    assert.equal((await emori.installation.install()).status, 'created');
    assert.equal((await smutlord.installation.install()).status, 'unchanged');
    assert.equal((await stat(join(root, 'agents/emori.sqlite'))).mode & 0o777, 0o600);
    await saveIntake(emori.agent, state);
    assert.equal(await smutlord.agent.readIntake(state.scope), undefined);
    const repo = {
      version: 1 as const,
      repositoryId: 'repo',
      source: 'origin',
      path: '/work/repo',
    };
    await emori.installation.saveRepository('/work', repo);
    assert.deepEqual(await smutlord.installation.readRepository('/work', repo.repositoryId), repo);
  });

  it('should let an independent writer finish before committing runtime state', async () => {
    const { agent } = bind(root, 'emori');
    await agent.install();
    const worker = new Worker(
      `
      const {parentPort, workerData} = require('node:worker_threads');
      const {DatabaseSync} = require('node:sqlite');
      const client = new DatabaseSync(workerData);
      client.exec('BEGIN IMMEDIATE');
      parentPort.once('message', () => setTimeout(() => { client.exec('COMMIT'); client.close(); }, 200));
      parentPort.postMessage('locked');
    `,
      { eval: true, workerData: join(root, 'agents/emori.sqlite') },
    );
    try {
      await once(worker, 'message');
      worker.postMessage('release');
      const state = sampleIntake('emori', baseline);
      await saveIntake(agent, state);
      assert.deepEqual(await agent.readIntake(state.scope), state);
    } finally {
      await worker.terminate();
    }
  });

  it('should preserve an older sqlite pickup enrollment across the next checkpoint', async () => {
    const { agent } = bind(root, 'receiver');
    await agent.install();
    const scope = 'a'.repeat(64);
    const key = pickupDispatchScope(scope);
    const pickup = {
      enrollment: {
        id: 'enrollment',
        scope,
        runtime: 'openclaw',
        workspaceDir: root,
        agentId: 'receiver',
        account: { login: 'receiver', nodeId: 'U1' },
        repositoryNodeId: 'R1',
        policyDigest: 'policy',
        startedAt: 1,
      },
      timezone: 'UTC',
      operations: [],
    };
    const value = { version: 4 as const, scope, resetGeneration: 'saved', projectPickup: pickup };
    await agent.write([{ table: 'dispatchState', action: 'insert', row: { scope: key, value } }]);
    const journal = new OpenClawDispatchStore(scope, sqliteDispatchPersistence(agent, key));
    assert.deepEqual((await journal.readEnvelope()).issuePickup, pickup);
    await journal.observeIntake(async (_state, save) => save());
    const reopened = bind(root, 'receiver').agent;
    const saved = await reopened.readDispatch(key);
    assert.deepEqual(saved?.issuePickup, pickup);
    assert.ok(saved && !Object.hasOwn(saved, 'projectPickup'));
    assert.equal(await reopened.readDispatch(scope), undefined);
  });

  it('should reject a competing dispatch checkpoint and fence an old generation after reopening', async () => {
    const { agent } = bind(root, 'emori');
    await agent.install();
    const peer = bind(root, 'emori').agent;
    const scope = 'one';
    const initial = { version: 4 as const, scope, resetGeneration: 'initial', records: [] };
    const first = { ...initial, discoveryCheckedAt: 1 };
    await agent.saveDispatch(scope, first, initial);
    await assert.rejects(
      peer.saveDispatch(scope, { ...initial, discoveryCheckedAt: 2 }, initial),
      /private-state-snapshot-conflict/,
    );
    const reset = { ...initial, resetGeneration: 'reset' };
    await peer.saveDispatch(scope, reset, first);
    await assert.rejects(
      agent.saveDispatch(scope, first, first),
      /notification-reset-stale-operation/,
    );
    const rows = await bind(root, 'emori').agent.read({ dispatchState: { scope } });
    assert.deepEqual(rows.dispatchState[0]!.value, { version: 4, scope, resetGeneration: 'reset' });
  });

  it('should preserve untouched journal rows and return records in workflow order', async () => {
    const { agent } = bind(root, 'emori');
    await agent.install();
    const state = sampleIntake('emori', baseline);
    const [first] = state.records;
    const second = { ...first!, id: 'later' };
    state.records.push(second);
    await saveIntake(agent, state);
    const db = new DatabaseSync(join(root, 'agents/emori.sqlite'));
    try {
      db.exec(`CREATE TRIGGER keep_first BEFORE DELETE ON intake_records WHEN old.id = 'same-record'
        BEGIN SELECT RAISE(ABORT, 'unrelated delete'); END`);
      second.admittedAt++;
      await saveIntake(agent, state);
      db.exec('DROP TRIGGER keep_first');
    } finally {
      db.close();
    }
    state.records.reverse();
    await saveIntake(agent, state);
    assert.deepEqual(await agent.readIntake(state.scope), state);
  });

  it('should roll back the checkpoint and records together on a failed replacement', async () => {
    const { agent } = bind(root, 'emori');
    await agent.install();
    const state = sampleIntake('emori', baseline + 1);
    await saveIntake(agent, state);
    await assert.rejects(
      saveIntake(agent, {
        ...state,
        checkpoint: baseline + 2,
        records: [...state.records, ...state.records],
      }),
    );
    assert.deepEqual(await agent.readIntake(state.scope), state);
  });

  it('should report the packaged upgrade without changing the database and apply it on install', async () => {
    const initial = '20261123213730_agent_records';
    const oldSchemas = join(root, 'old');
    await cp(join(schemaRoot, 'migrations', initial), join(oldSchemas, 'migrations', initial), {
      recursive: true,
    });
    const database = bind(root, 'first').agent;
    const path = join(root, 'agents/first.sqlite');
    assert.equal((await database.inspect()).code, 'agent-storage-missing');
    await assert.rejects(stat(path), { code: 'ENOENT' });
    await bind(root, 'first', oldSchemas).agent.install();
    const db = new DatabaseSync(path);
    try {
      db.prepare('INSERT INTO reply_drafts VALUES (?, ?, ?)').run(
        'chat',
        'draft',
        '{"body":"keep me"}',
      );
    } finally {
      db.close();
    }
    const before = await readFile(path);
    const finding = await database.inspect();
    assert.equal(finding.code, 'agent-storage-migrations-pending');
    assert.match(finding.message, /workflow_state/);
    assert.ok(!finding.message.includes(initial));
    assert.deepEqual(await readFile(path), before);
    assert.equal((await database.install()).status, 'updated');
    assert.equal((await database.inspect()).status, 'healthy');
    const upgraded = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(
        upgraded.prepare('SELECT value FROM reply_drafts').get()?.value,
        '{"body":"keep me"}',
      );
      assert.equal(
        upgraded.prepare('SELECT count(*) AS n FROM automation_registrations').get()?.n,
        0,
      );
      assert.equal(
        upgraded
          .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'assignment_claims'")
          .get()?.n,
        0,
      );
    } finally {
      upgraded.close();
    }
  });

  it('should carry attempted, observed and retired replies into the shared installation on upgrade', async () => {
    const oldSchemas = join(root, 'prior');
    for (const migration of [
      '20261123221502_installation_state',
      '20261124015723_remove_shared_pickup_enrollments',
    ]) {
      await cp(
        join(schemaRoot, 'installation-migrations', migration),
        join(oldSchemas, 'installation-migrations', migration),
        { recursive: true },
      );
    }
    await bind(root, 'first', oldSchemas).installation.install();
    const first = bind(root, 'first');
    const second = bind(root, 'second');
    await first.agent.install();
    await second.agent.install();
    const publication = (id: string) =>
      JSON.stringify({
        item: { lifecycleId: 'issue', repositoryNodeId: 'R_fixture', number: 1 },
        intent: 'manual-response',
        publicationId: id,
        text: 'private fixture text',
      });
    const publisher = 'U_owner';
    for (const name of ['first', 'second']) {
      const db = new DatabaseSync(join(root, 'agents', name + '.sqlite'));
      try {
        const add = db.prepare('INSERT INTO reply_drafts VALUES (?, ?, ?)');
        for (const [id, state] of Object.entries({
          pending: { attempted: true },
          observed: { receipt: { nodeId: 'C_one', databaseId: 1 } },
          ready: {},
          rejected: { attempted: false },
        }))
          add.run(
            'scope',
            id,
            JSON.stringify({ ...state, authorNodeId: publisher, publication: publication(id) }),
          );
        db.prepare('INSERT INTO dispatch_state VALUES (?, ?)').run(
          'scope',
          JSON.stringify({
            retirementEffects: [
              { kind: 'comment', accountId: publisher, publication: publication('retired') },
            ],
          }),
        );
      } finally {
        db.close();
      }
    }
    assert.equal((await first.installation.install()).status, 'updated');
    const read = async () =>
      (await second.installation.read({ replyPublications: { publisher } })).replyPublications;
    const rows = await read();
    assert.equal(rows.length, 3);
    const ids = ['pending', 'observed', 'retired'];
    const draft = (id: string, authorNodeId = publisher) => ({
      authorNodeId,
      publication: publication(id),
    });
    for (const id of ids) {
      assert.equal(await second.agent.hasReplyPublication(draft(id)), true);
      assert.equal(await second.agent.hasReplyPublication(draft(id, 'U_other')), false);
    }
    for (const id of ['ready', 'rejected'])
      assert.equal(await second.agent.hasReplyPublication(draft(id)), false);
    assert.equal((await first.installation.install()).status, 'unchanged');
    assert.deepEqual(await read(), rows);
  });

  it('should upgrade pickup enrollment ownership without discarding shared data', async () => {
    const oldSchemas = join(root, 'pilot');
    for (const [chain, migration] of [
      ['migrations', '20261123213730_agent_records'],
      ['migrations', '20261123221501_workflow_state'],
      ['installation-migrations', '20261123221502_installation_state'],
    ] as const) {
      await cp(join(schemaRoot, chain, migration), join(oldSchemas, chain, migration), {
        recursive: true,
      });
    }
    const pilot = bind(root, 'pirog', oldSchemas);
    await pilot.agent.install();
    await pilot.installation.install();
    const current = bind(root, 'pirog');
    assert.equal((await current.agent.inspect()).code, 'agent-storage-migrations-pending');
    assert.equal(
      (await current.installation.inspect()).code,
      'agent-system-storage-migrations-pending',
    );
    assert.equal((await current.agent.install()).status, 'updated');
    const path = join(root, 'instance/agent-system.sqlite');
    const shared = new DatabaseSync(path);
    try {
      shared.prepare('INSERT INTO pickup_enrollments VALUES (?, ?, ?)').run('codex', 'test', '{}');
      await assert.rejects(current.installation.install());
      assert.equal(shared.prepare('SELECT scope FROM pickup_enrollments').get()?.scope, 'test');
      shared.exec('DELETE FROM pickup_enrollments');
      assert.equal((await current.installation.install()).status, 'updated');
      assert.equal(
        shared.prepare("SELECT name FROM sqlite_schema WHERE name = 'pickup_enrollments'").get(),
        undefined,
      );
    } finally {
      shared.close();
    }
    const agent = new DatabaseSync(join(root, 'agents/pirog.sqlite'), { readOnly: true });
    try {
      assert.equal(agent.prepare('SELECT count(*) AS n FROM pickup_enrollments').get()?.n, 0);
    } finally {
      agent.close();
    }
    assert.equal((await current.agent.install()).status, 'unchanged');
    assert.equal((await current.installation.install()).status, 'unchanged');
  });

  it('should refuse to initialize another agent through a linked database', async () => {
    await bind(root, 'first').agent.install();
    await symlink(join(root, 'agents/first.sqlite'), join(root, 'agents/second.sqlite'));
    await assert.rejects(bind(root, 'second').agent.install(), { code: 'ELOOP' });
  });
});
