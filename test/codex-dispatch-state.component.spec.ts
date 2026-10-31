import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import CodexDispatchStore from '../agent/codex-dispatch-state.ts';

describe('agent/codex-dispatch-state', () => {
  let root: string;
  let store: CodexDispatchStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dispatch-state-'));
    store = new CodexDispatchStore(root, 'a'.repeat(64));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should initialize absent state and report malformed evidence without replacing it', async () => {
    assert.deepEqual(await store.read(), {
      version: 1,
      scope: store.scope,
      resetGeneration: 'initial',
      records: [],
    });
    for (const contents of [
      '{"version":',
      '',
      'null',
      '{"version":2}',
      JSON.stringify({ version: 1, scope: 'b'.repeat(64), records: [] }),
    ]) {
      await store.file.write(contents);
      await assert.rejects(store.read(), { message: 'dispatch-state-invalid' });
      await assert.rejects(
        store.exclusive(async () => assert.fail('corrupt evidence reached a writer')),
        { message: 'dispatch-state-invalid' },
      );
      assert.equal(await readFile(store.path, 'utf8'), contents);
    }
  });

  it('should reject restored pre-reset workflows before interpreting their historical payload', async () => {
    const contents = JSON.stringify({
      version: 1,
      scope: store.scope,
      records: [
        { retired: { at: 1, by: 'old-owner' }, result: { decision: { action: 'proceed' } } },
      ],
    });
    await store.file.write(contents);
    await assert.rejects(store.read(), /notification-state-reset-required/);
    await assert.rejects(
      store.exclusive(async () => assert.fail('old workflows reached execution')),
      /notification-state-reset-required/,
    );
    assert.equal(await readFile(store.path, 'utf8'), contents);
  });

  it('should reject removed workflow fields instead of repairing or replaying them', async () => {
    const current = await store.read();
    for (const fields of [
      { compatibilityRecovery: { version: 1, codes: [] } },
      { notice: 'b'.repeat(64) },
    ]) {
      const contents = JSON.stringify({
        ...current,
        records: [
          {
            id: 'b'.repeat(64),
            intakeId: 'b'.repeat(64),
            issueKey: 'b'.repeat(64),
            sourceThreadId: 'owner',
            phase: 'routing',
            createdAt: 1,
            manifestDigest: 'manifest',
            ...fields,
          },
        ],
      });
      await store.file.write(contents);
      await assert.rejects(store.read(), /dispatch-state-invalid/);
      assert.equal(await readFile(store.path, 'utf8'), contents);
    }
  });

  it('should preserve filesystem denials instead of classifying them as malformed state', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      const denied = Object.assign(new Error('denied'), { code });
      store.file.read = async () => {
        throw denied;
      };
      await assert.rejects(store.read(), (error: unknown) => error === denied);
    }
  });

  it('should retain branch preparation but reject ownership copied from another attempt', async () => {
    await store.exclusive(async (state, save) => {
      state.records.push({
        id: 'b'.repeat(64),
        intakeId: 'b'.repeat(64),
        issueKey: 'b'.repeat(64),
        sourceThreadId: 'intake',
        phase: 'routing',
        createdAt: 1,
        manifestDigest: 'manifest',
        issueBranch: { attemptId: 'b'.repeat(64), name: '42-owned-branch', phase: 'creating' },
      });
      await save();
    });
    const retained = await store.read();
    assert.equal(retained.records[0]!.issueBranch?.phase, 'creating');
    await assert.rejects(
      store.exclusive(async (state, save) => {
        state.records[0]!.issueBranch!.attemptId = 'c'.repeat(64);
        await save();
      }),
      /dispatch-state-invalid/,
    );
    assert.deepEqual(await store.read(), retained);
  });

  it('should round-trip escaped reporting text without replacing working content', async () => {
    const response = '\u0000界'.repeat(12);
    await store.exclusive(async (state, save) => {
      state.records.push({
        id: 'b'.repeat(64),
        issueKey: 'b'.repeat(64),
        intakeId: 'b'.repeat(64),
        sourceThreadId: 'intake',
        phase: 'routing',
        createdAt: 1,
        manifestDigest: 'manifest',
        context: 'full working context',
      });
      state.run = {
        id: 'run',
        automationId: 'intake',
        currentTimeIso: '2026-10-12T12:00:00.000Z',
        actions: 1,
      };
      await save();
      state.run.response = response;
      await save();
    });
    const saved = await store.read();
    assert.equal(saved.run?.response, response);
    assert.equal(saved.records[0]!.context, 'full working context');
  });
});
