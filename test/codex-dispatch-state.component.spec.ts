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

  it('should retain the storage limit for work records', async () => {
    const before = await store.read();
    await assert.rejects(
      store.exclusive(async (state, save) => {
        state.records = Array.from({ length: 50 }, (_, i) => ({
          id: i.toString(16).padStart(64, '0'),
          issueKey: i.toString(16).padStart(64, '0'),
          intakeId: 'b'.repeat(64),
          sourceThreadId: 'intake',
          phase: 'routing',
          createdAt: 1,
          manifestDigest: 'manifest',
          context: 'x'.repeat(96000),
        }));
        await save();
      }),
      /dispatch-state-capacity/,
    );
    assert.deepEqual(await store.read(), before);
  });

  it('should reserve room for an escaped report without letting work consume that room', async () => {
    const response = '\u0000'.repeat(128000);
    await store.exclusive(async (state, save) => {
      state.records = Array.from({ length: 44 }, (_, i) => ({
        id: i.toString(16).padStart(64, '0'),
        issueKey: i.toString(16).padStart(64, '0'),
        intakeId: 'b'.repeat(64),
        sourceThreadId: 'intake',
        phase: 'routing',
        createdAt: 1,
        manifestDigest: 'manifest',
        context: i < 43 ? 'x'.repeat(96000) : '',
      }));
      state.run = {
        id: 'run',
        automationId: 'intake',
        currentTimeIso: '2026-10-12T12:00:00.000Z',
        actions: 1,
      };
      state.records.at(-1)!.context = 'x'.repeat(
        4 * 1024 * 1024 - 100 - Buffer.byteLength(JSON.stringify(state)),
      );
      await save();
      state.run.response = response;
      await save();
    });
    assert.equal((await store.read()).run?.response, response);
    await assert.rejects(
      store.exclusive(async (state, save) => {
        state.records.at(-1)!.context += 'x'.repeat(101);
        await save();
      }),
      /dispatch-state-capacity/,
    );
    assert.equal((await store.read()).run?.response, response);
  });
});
