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
    assert.deepEqual(await store.read(), { version: 1, scope: store.scope, records: [] });
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

  it('should preserve filesystem denials instead of classifying them as malformed state', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      const denied = Object.assign(new Error('denied'), { code });
      store.file.read = async () => {
        throw denied;
      };
      await assert.rejects(store.read(), (error: unknown) => error === denied);
    }
  });

  it('should drop legacy presentation data and retain the storage limit for work records', async () => {
    await store.exclusive(async (state, save) => {
      state.notices = [{ id: 'b'.repeat(64), message: 'old report', notify: true }];
      state.reports = [{ response: 'old final', createdAt: 1, notices: ['b'.repeat(64)] }];
      await save();
    });
    const before = await store.read();
    assert.equal(before.notices, undefined);
    assert.equal(before.reports, undefined);
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
