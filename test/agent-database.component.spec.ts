import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatabaseSync } from 'node:sqlite';
import { bindSqliteStorage } from '../agent/storage/agent-database.ts';
import type { StorageBinding } from '../agent/storage/storage-lifecycle.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';
import { account, baseline, intakeFixture } from './github-intake-fixture.ts';

const schemaRoot = fileURLToPath(new URL('../agent/storage/', import.meta.url));

function bind(
  root: string,
  runtime: StorageBinding['runtime'],
  agentId: string,
  schemas = schemaRoot,
) {
  return bindSqliteStorage(
    {
      agentRoot: join(root, 'agents'),
      installationRoot: join(root, 'instance'),
      schemaRoot: schemas,
    },
    { runtime, agentId, workspaceDir: '/work/' + agentId },
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

describe('agent database', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-storage-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should keep two codex installs independent even with the same agent, workspace and record ids', async () => {
    const laptopA = bind(join(root, 'laptop-a'), 'codex', 'pirog');
    const laptopB = bind(join(root, 'laptop-b'), 'codex', 'pirog');
    const a = sampleIntake('pirog', baseline + 1);
    const b = sampleIntake('pirog', baseline + 2);
    await assert.rejects(laptopA.agent.readIntake(a.scope), { code: 'ENOENT' });
    await laptopA.agent.install();
    await laptopB.agent.install();
    await laptopA.agent.saveIntake(a);
    await laptopB.agent.saveIntake(b);
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
    const emori = bind(root, 'openclaw', 'emori');
    const smutlord = bind(root, 'openclaw', 'smutlord');
    const state = sampleIntake('emori', baseline + 1);
    for (const store of [emori, smutlord]) await store.agent.install();
    assert.equal((await emori.installation.install()).status, 'created');
    assert.equal((await smutlord.installation.install()).status, 'unchanged');
    assert.equal((await stat(join(root, 'agents/emori.sqlite'))).mode & 0o777, 0o600);
    await emori.agent.saveIntake(state);
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

  it('should roll back the checkpoint and records together on a failed replacement', async () => {
    const { agent } = bind(root, 'openclaw', 'emori');
    await agent.install();
    const state = sampleIntake('emori', baseline + 1);
    await agent.saveIntake(state);
    await assert.rejects(
      agent.saveIntake({
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
    const database = bind(root, 'openclaw', 'first').agent;
    const path = join(root, 'agents/first.sqlite');
    assert.equal((await database.inspect()).code, 'agent-storage-missing');
    await assert.rejects(stat(path), { code: 'ENOENT' });
    await bind(root, 'openclaw', 'first', oldSchemas).agent.install();
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

  it('should refuse to initialize another agent through a linked database', async () => {
    await bind(root, 'openclaw', 'first').agent.install();
    await symlink(join(root, 'agents/first.sqlite'), join(root, 'agents/second.sqlite'));
    await assert.rejects(bind(root, 'openclaw', 'second').agent.install(), { code: 'ELOOP' });
  });
});
