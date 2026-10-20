import assert from 'node:assert/strict';
import acceptOccurrence from '../agent/codex-intake-occurrence.ts';
import type CodexDispatchStore from '../agent/codex-dispatch-state.ts';

describe('codex intake occurrence', () => {
  it('should retain an accepted occurrence and verify the next occurrence before replacing it', async () => {
    const state: Awaited<ReturnType<CodexDispatchStore['read']>> = {
      version: 1,
      scope: 'a'.repeat(64),
      records: [],
    };
    const first = { id: 'turn-1', automationId: 'job', currentTimeIso: '2026-10-20T00:00:00Z' };
    let paused = false,
      writes = 0;
    const active = async () => {
      if (paused) throw new Error('intake-automation-paused');
    };
    const save = async () => {
      writes++;
    };
    await acceptOccurrence(state, first, active, save);
    paused = true;
    await acceptOccurrence(state, first, active, save);
    assert.equal(writes, 1);
    await assert.rejects(
      acceptOccurrence(state, { ...first, automationId: 'foreign' }, active, save),
      /dispatch-occurrence-mismatch/u,
    );
    const second = { ...first, id: 'turn-2' };
    await assert.rejects(
      acceptOccurrence(state, second, active, save),
      /intake-automation-paused/u,
    );
    assert.equal(state.run!.id, first.id);
    paused = false;
    await acceptOccurrence(state, second, active, save);
    assert.equal(state.run!.id, second.id);
    assert.equal(writes, 2);
  });
});
