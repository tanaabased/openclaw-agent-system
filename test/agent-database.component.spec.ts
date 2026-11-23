import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';

import { AgentDatabase } from '../agent/storage/agent-database.ts';
import { dispatchRecords, intakeRecords, replyDrafts } from '../agent/storage/schema.ts';

const migrations = fileURLToPath(new URL('../agent/storage/migrations/', import.meta.url));

describe('agent database', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-storage-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should isolate the same logical record across agents and preserve edits on reinstall', async () => {
    const first = new AgentDatabase(root, 'first');
    const second = new AgentDatabase(root, 'second');
    await assert.rejects(first.open(), { code: 'ENOENT' });
    const id = 'a'.repeat(64);
    const initial = {
      id,
      issueKey: 'b'.repeat(64),
      sourceThreadId: 'intake',
      createdAt: 1,
      manifestDigest: 'manifest',
    };
    for (const agent of [first, second]) {
      assert.equal((await agent.install(migrations)).status, 'created');
      assert.equal((await stat(agent.path)).mode & 0o777, 0o600);
      const db = await agent.open();
      try {
        assert.deepEqual(await db.select().from(intakeRecords), []);
        assert.deepEqual(await db.select().from(replyDrafts), []);
        await db.insert(dispatchRecords).values({ id, scope: 'scope', value: initial });
      } finally {
        db.$client.close();
      }
    }
    const updated = { ...initial, threadId: 'issue-chat' };
    const db = await first.open();
    try {
      await db.update(dispatchRecords).set({ value: updated }).where(eq(dispatchRecords.id, id));
    } finally {
      db.$client.close();
    }
    for (const agent of [first, second]) {
      assert.equal((await agent.install(migrations)).status, 'unchanged');
      const db = await agent.open();
      try {
        assert.deepEqual(await db.select().from(dispatchRecords), [
          { scope: 'scope', id, value: agent === first ? updated : initial },
        ]);
      } finally {
        db.$client.close();
      }
    }
  });

  it('should report the packaged upgrade without changing the database and apply it on install', async () => {
    const initial = '20261123213730_agent_records';
    const oldMigrations = join(root, 'old-migrations');
    await cp(join(migrations, initial), join(oldMigrations, initial), { recursive: true });
    const database = new AgentDatabase(root, 'first');
    assert.equal((await database.inspect(migrations)).code, 'agent-storage-missing');
    await assert.rejects(stat(database.path), { code: 'ENOENT' });
    await database.install(oldMigrations);
    const db = await database.open();
    try {
      db.$client
        .prepare('INSERT INTO reply_drafts VALUES (?, ?, ?)')
        .run('chat', 'draft', '{"body":"keep me"}');
    } finally {
      db.$client.close();
    }
    const before = await readFile(database.path);
    const finding = await database.inspect(migrations);
    assert.equal(finding.code, 'agent-storage-migrations-pending');
    assert.match(finding.message, /workflow_state/);
    assert.ok(!finding.message.includes(initial));
    assert.deepEqual(await readFile(database.path), before);
    assert.equal((await database.install(migrations)).status, 'updated');
    assert.equal((await database.inspect(migrations)).status, 'healthy');
    const upgraded = await database.open();
    try {
      assert.equal(
        upgraded.$client.prepare('SELECT value FROM reply_drafts').get()?.value,
        '{"body":"keep me"}',
      );
      assert.equal(
        upgraded.$client.prepare('SELECT count(*) AS n FROM automation_registrations').get()?.n,
        0,
      );
      assert.equal(
        upgraded.$client
          .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'assignment_claims'")
          .get()?.n,
        0,
      );
    } finally {
      upgraded.$client.close();
    }
  });

  it('should refuse to initialize another agent through a linked database', async () => {
    const first = new AgentDatabase(root, 'first');
    const second = new AgentDatabase(root, 'second');
    await first.install(migrations);
    await symlink(first.path, second.path);
    await assert.rejects(second.install(migrations), { code: 'ELOOP' });
  });
});
