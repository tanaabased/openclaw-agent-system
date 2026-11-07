import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import codexDispatchHandoff from '../agent/codex-dispatch-handoff.ts';

describe('agent/codex-runtime', () => {
  it('should report an early pickup failure in its native envelope while exiting unsuccessfully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-pickup-failure-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['dist/codex/codex-runtime.js', 'intake', 'pickup', '--plugin-data', root],
        { input: '{}', encoding: 'utf8', timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.status, 'error');
      assert.match(failure.response, /<decision>NOTIFY<\/decision>/);
      assert.match(failure.response, /❌.*Issue pickup/);
      assert.ok(failure.response.includes(failure.code));
      assert.match(failure.response, /Next/);
      assert.equal(failure.notice, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('should run the built failure formatter through the saved path launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-failure-formatter-'));
    try {
      const saved = codexDispatchHandoff({
        entrypoint: resolve('dist/codex/codex-runtime.js'),
        pluginData: root,
      });
      const output: { exit_code: number; output: string }[] = [];
      await runInNewContext('(async () => {' + saved + '})()', {
        runtimeRoute: 'intake',
        runtimeInput: {
          action: 'failure-response',
          automationId: 'disposable',
          code: 'codex-runtime-failed',
        },
        load: () => undefined,
        store: () => {},
        text: (value: { exit_code: number; output: string }) => output.push(value),
        tools: {
          exec_command: async ({ cmd }: { cmd: string }) => {
            const result = spawnSync('/bin/sh', ['-c', cmd], {
              env: { ...process.env, PATH: dirname(process.execPath) },
              encoding: 'utf8',
              timeout: 10000,
            });
            assert.ifError(result.error);
            return { exit_code: result.status, output: result.stdout + result.stderr };
          },
        },
      });
      assert.equal(output.at(-1)!.exit_code, 0);
      assert.equal(JSON.parse(output.at(-1)!.output).status, 'failure');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
  it('should unwrap prepared publication input only under the visible publish command', () => {
    const input = JSON.stringify({
      status: 'prepared',
      publishRequest: { action: 'publish', id: 'invalid' },
    });
    for (const [action, code] of [
      ['publish', 'delivery-request-invalid'],
      ['prepare', 'workflow-prepared-publication-invalid'],
    ]) {
      const result = spawnSync(
        process.execPath,
        ['dist/codex/codex-runtime.js', 'delivery', action!, '--plugin-data', '/unused'],
        { input, encoding: 'utf8', timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.code, code);
    }
  });

  it('should diagnose missing or malformed workflow stdin before accessing state without echoing input', () => {
    for (const input of ['', '{"private-value":']) {
      const result = spawnSync(
        process.execPath,
        ['dist/codex/codex-runtime.js', 'dispatch', 'context', '--plugin-data', '/unused'],
        { input, encoding: 'utf8', timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.code, 'workflow-request-invalid');
      assert.match(failure.message, /JSON on stdin/);
      assert.match(failure.message, /no workflow operation was attempted/);
      assert.doesNotMatch(result.stderr, /private-value/);
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
