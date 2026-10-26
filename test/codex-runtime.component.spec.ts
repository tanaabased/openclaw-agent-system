import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent/codex-runtime', () => {
  it('should reject unsupported node before accessing workflow state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-node-version-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"1.0.0"})',
          'dist/codex/codex-runtime.js',
          'intake',
          'scan',
          '--plugin-data',
          join(root, 'uncreated'),
        ],
        { input: '{}', encoding: 'utf8', timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.code, 'codex-node-version-unsupported');
      assert.match(failure.message, /1\.0\.0.*PATH/u);
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('should explain unsupported input flags before reading workflow stdin', () => {
    for (const route of ['dispatch', 'continuation', 'delivery', 'feedback']) {
      const result = spawnSync(
        process.execPath,
        ['dist/codex/codex-runtime.js', route, '--plugin-data', '/unused', '--input', '-'],
        { input: '', encoding: 'utf8', timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.status, 'error');
      assert.match(failure.message, /--plugin-data.*stdin.*--input/);
    }
  });

  it('should reject a hidden publish request passed to the preparation command', async () => {
    const result = spawnSync(
      process.execPath,
      ['dist/codex/codex-runtime.js', 'delivery', 'prepare', '--plugin-data', '/unused'],
      {
        input: JSON.stringify({ action: 'publish', id: 'a'.repeat(64) }),
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).message, 'workflow-command-action-mismatch');
  });

  it('should route manual launch through the built command to the binding guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-launch-route-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['dist/codex/codex-runtime.js', 'dispatch', 'launch', 'context', '--plugin-data', root],
        {
          input: JSON.stringify({
            action: 'launch',
            operation: 'context',
            target: 'tanaabased/big-test-bucket#1',
          }),
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).code, 'intake-binding-unavailable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should route summary requests through the built command to the binding guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-summary-route-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['dist/codex/codex-runtime.js', 'dispatch', 'summary', 'compose', '--plugin-data', root],
        {
          input: JSON.stringify({ action: 'summary', id: 'a'.repeat(64), operation: 'compose' }),
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.code, 'intake-binding-unavailable');
      assert.equal(failure.operation, 'dispatch:summary:compose');
      assert.equal(failure.id, 'a'.repeat(64));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
