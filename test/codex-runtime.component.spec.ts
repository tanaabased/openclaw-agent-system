import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import codexDispatchHandoff from '../agent/tasks/dispatch/codex-dispatch-handoff.ts';
import { bindCodexWorkspace } from '../agent/identity/codex-workspace-binding.ts';

describe('agent/codex-runtime', () => {
  it('uses standalone storage settings and keeps the configured backend when another agent installs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-backend-'));
    try {
      const workspace = join(root, 'workspace');
      const pluginData = join(root, 'data');
      const config = join(root, 'openclaw.json');
      const saved = join(pluginData, 'instance', 'storage.json');
      await mkdir(workspace);
      await writeFile(join(workspace, 'agent.yaml'), 'schema-version: 1\nagent: {id: emori}\n');
      await bindCodexWorkspace(pluginData, workspace);
      const run = (args: string[], input = {}) =>
        spawnSync(
          process.execPath,
          ['dist/codex/codex-runtime.js', ...args, '--plugin-data', pluginData],
          {
            encoding: 'utf8',
            input: JSON.stringify(input),
            env: { ...process.env, OPENCLAW_CONFIG_PATH: config, CODEX_HOME: root },
          },
        );
      await writeFile(
        config,
        '{"plugins":{"entries":{"agent-system":{"config":{"storage":{"backend":"file"}}}}}}',
      );
      const before = run(['setup', 'inspect']);
      assert.equal(before.status, 0, before.stderr);
      await assert.rejects(access(saved), { code: 'ENOENT' });
      const installed = run(['setup', 'install']);
      assert.equal(installed.status, 0, installed.stderr);
      assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), { backend: { type: 'sqlite' } });
      const renamed = run(['instance', 'rename'], { name: 'pilot' });
      assert.equal(renamed.status, 0, renamed.stderr);
      const operatorSettings = '{"backend":"sqlite"}\n';
      await writeFile(saved, operatorSettings);
      const second = join(root, 'second');
      await mkdir(second);
      await writeFile(
        join(second, 'agent.yaml'),
        'schema-version: 1\nagent: {id: smutlord}\nstorage: {backend: {type: sqlite}}\n',
      );
      await bindCodexWorkspace(pluginData, second);
      const repeated = run(['setup', 'install']);
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.equal(await readFile(saved, 'utf8'), operatorSettings);
      const current = run(['instance', 'inspect']);
      assert.equal(current.status, 0, current.stderr);
      assert.equal(JSON.parse(current.stdout).displayName, 'pilot');

      await writeFile(saved, '{"backend":"file"}');
      const file = run(['instance', 'rename'], { name: 'other' });
      assert.equal(file.status, 1);
      assert.match(file.stderr, /file workflow storage has been retired/i);
      await writeFile(saved, '{"backend":"sqltie"}');
      const invalid = run(['instance', 'rename'], { name: 'other' });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /storage.backend/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects copied native inventories and effect receipts before reading state or performing effects', () => {
    const cases = [
      {
        args: ['automations', 'prepare'],
        input: { digest: 'a'.repeat(64) },
        code: 'automation-model-request-invalid',
      },
      {
        args: ['automations', 'plan'],
        input: { projects: {} },
        code: 'native-inventory-binding-override',
      },
      {
        args: ['instance', 'rotate'],
        input: { expectedInstanceId: 'owned-id' },
        code: 'instance-model-request-invalid',
      },
      {
        args: ['notifications', 'reset'],
        input: { yes: true, confirmation: 'receipt' },
        code: 'notification-reset-model-request-invalid',
      },
      {
        args: ['dispatch', 'next'],
        input: { projects: [], threads: {} },
        code: 'native-inventory-binding-override',
      },
      {
        args: ['dispatch', 'review', 'next'],
        input: { projects: [], threads: {} },
        code: 'native-inventory-binding-override',
      },
    ];
    for (const test of cases) {
      const result = spawnSync(
        process.execPath,
        ['dist/codex/codex-runtime.js', ...test.args, '--plugin-data', '/unused'],
        {
          input: JSON.stringify(test.input),
          env: { ...process.env, CODEX_THREAD_ID: 'native-caller' },
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr).code, test.code);
    }
  });

  it('should accept empty lookup input while retaining native caller binding', () => {
    for (const input of ['', ' \n', '{}', '{"threadId":"foreign"}']) {
      const env = { ...process.env };
      delete env.CODEX_THREAD_ID;
      const result = spawnSync(
        process.execPath,
        ['dist/codex/codex-runtime.js', 'turn-context', '--plugin-data', '/unused'],
        { input, env, encoding: 'utf8', timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(
        JSON.parse(result.stderr).code,
        input.includes('threadId')
          ? 'turn-context-request-invalid'
          : 'turn-context-native-caller-required',
      );
    }
  });
  it('should deliver a private per-prompt probe without receipts or plugin state changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-turn-probe-'));
    const workspace = join(root, 'workspace');
    const pluginData = join(root, 'data');
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, 'agent.yaml'), 'schema-version: 1\nagent:\n  id: probe\n');
      await bindCodexWorkspace(pluginData, workspace);
      const files = await readdir(pluginData);
      const before = await Promise.all(
        files.map((file) => readFile(join(pluginData, file), 'utf8')),
      );
      for (const turn of ['initial-assignment', 'later-feedback']) {
        const result = spawnSync(
          process.execPath,
          ['dist/codex/codex-runtime.js', 'user-prompt-submit'],
          {
            input: JSON.stringify({
              hook_event_name: 'UserPromptSubmit',
              session_id: 'native-thread',
              turn_id: turn,
              prompt: 'PRIVATE-PROVIDER-TEXT',
            }),
            env: { ...process.env, PLUGIN_DATA: pluginData },
            encoding: 'utf8',
            timeout: 10000,
          },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0);
        assert.equal(result.stderr, '');
        const output = JSON.parse(result.stdout).hookSpecificOutput;
        assert.equal(output.hookEventName, 'UserPromptSubmit');
        const facts = JSON.parse(output.additionalContext.split('\n')[1]);
        assert.equal(facts.contextProbe.runtime, 'codex');
        assert.deepEqual(facts.currentTurn, { threadId: 'native-thread', turnId: turn });
        assert.doesNotMatch(result.stdout, /PRIVATE-PROVIDER-TEXT/);
      }
      assert.deepEqual(await readdir(pluginData), files);
      assert.deepEqual(
        await Promise.all(files.map((file) => readFile(join(pluginData, file), 'utf8'))),
        before,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('should keep probe failures silent and non-blocking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-turn-probe-unbound-'));
    try {
      for (const input of [
        '',
        'not-json',
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'chat',
          turn_id: 'turn',
        }),
      ]) {
        const result = spawnSync(
          process.execPath,
          ['dist/codex/codex-runtime.js', 'user-prompt-submit'],
          {
            input,
            env: { ...process.env, PLUGIN_DATA: root },
            encoding: 'utf8',
            timeout: 10000,
          },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0);
        assert.equal(result.stderr, '');
        assert.deepEqual(JSON.parse(result.stdout), {});
      }
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
      assert.match(failure.response, /❌.*ISSUE PICKUP/);
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
      ['publish', 'native-context-binding-override'],
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
      assert.equal(failure.notice.severity, 'error');
      assert.match(failure.notice.message, /^> ## ❌/);
      assert.ok(failure.notice.message.includes('`workflow-request-invalid`'));
      assert.equal(typeof failure.presentationInstructions, 'string');
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
});
