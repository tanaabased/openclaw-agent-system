import assert from 'node:assert/strict';
import {
  dispatchStorageBytes,
  dispatchStorageLevel,
  dispatchStorageNotice,
  dispatchStorageViolation,
} from '../agent/dispatch-storage.ts';
import type { DispatchState } from '../agent/codex-dispatch-state.ts';

const mib = 1024 * 1024;
describe('agent/dispatch storage', () => {
  it('should warn before pausing new work and retain emergency headroom for existing work', () => {
    for (const [bytes, expected] of [
      [16 * mib - 1, 'normal'],
      [16 * mib, 'warning'],
      [32 * mib - 1, 'warning'],
      [32 * mib, 'paused'],
      [64 * mib, 'emergency'],
    ] as const)
      assert.equal(dispatchStorageLevel(bytes), expected);
    const atPause = { contentBytes: 32 * mib, totalBytes: 32 * mib };
    assert.equal(dispatchStorageViolation(atPause, true), 'dispatch-storage-admission-paused');
    assert.equal(dispatchStorageViolation(atPause, false), undefined);
    assert.equal(
      dispatchStorageViolation({ contentBytes: 32 * mib - 1, totalBytes: 32 * mib }, true),
      undefined,
    );
  });

  it('should enforce both emergency ceilings while allowing the reporting reserve', () => {
    assert.equal(
      dispatchStorageViolation({ contentBytes: 64 * mib, totalBytes: 65 * mib }, false),
      undefined,
    );
    assert.equal(
      dispatchStorageViolation({ contentBytes: 64 * mib + 1, totalBytes: 64 * mib + 1 }, false),
      'dispatch-state-capacity',
    );
    assert.equal(
      dispatchStorageViolation({ contentBytes: 63 * mib, totalBytes: 65 * mib + 1 }, false),
      'dispatch-state-capacity',
    );
  });

  it('should count escaped utf8 content and reserve only generated reporting text', () => {
    const state: DispatchState = {
      version: 1,
      scope: 'a'.repeat(64),
      records: [],
      run: {
        id: 'run',
        automationId: 'auto',
        currentTimeIso: 'now',
        actions: 0,
        response: '\u0000界',
      },
      intakeReport: { fingerprint: 'a'.repeat(64), problems: [], runId: 'run', response: 'report' },
      continuationRun: { id: 'run', actions: 0, responses: ['report'] },
    };
    const measured = dispatchStorageBytes(state);
    const stripped = structuredClone(state);
    delete stripped.run!.response;
    stripped.intakeReport!.response = '';
    delete stripped.continuationRun!.responses;
    assert.equal(measured.totalBytes, Buffer.byteLength(JSON.stringify(state)));
    assert.equal(measured.contentBytes, dispatchStorageBytes(stripped).contentBytes);
    assert.ok(measured.totalBytes > measured.contentBytes);
    assert.equal(dispatchStorageNotice(state).key, 'normal');
    state.run!.id += '界';
    assert.equal(dispatchStorageBytes(state).contentBytes, measured.contentBytes + 3);
  });
});
