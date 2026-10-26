import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import codexPermission from '../agent/codex-permission.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';

describe('agent/codex-permission', () => {
  let root: string, script: string;
  let runtime: { nodeExecutable: string; pluginRoot: string; pluginData: string };
  const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const allowed = {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  };
  const event = (command: string) => ({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command, description: 'arbitrary provider prose' },
  });
  const command = (args = 'binding inspect') =>
    `${quote(runtime.nodeExecutable)} ${quote(script)} ${args} --plugin-data ${quote(runtime.pluginData)}`;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'permission-hook-'));
    runtime = {
      nodeExecutable: process.execPath,
      pluginRoot: join(root, "plugin's path with spaces"),
      pluginData: join(root, 'installation data'),
    };
    script = join(runtime.pluginRoot, 'dist/codex/codex-runtime.js');
    await mkdir(join(runtime.pluginRoot, 'dist/codex'), { recursive: true });
    await writeFile(script, '// fixture runtime\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should delegate present and future runtime operations without a second operation registry', async () => {
    for (const args of [
      'dispatch summary publish',
      'feedback reply publish',
      'delivery publish',
      'notifications reset',
      'review-request future-operation',
      'future-route future-action',
    ]) {
      assert.deepEqual(await codexPermission(runtime, event(command(args))), allowed);
      assert.deepEqual(await codexPermission(runtime, event(command(args))), allowed);
    }
    await assert.rejects(readdir(runtime.pluginData), { code: 'ENOENT' });
  });

  it('should allow direct paths, literal quoting and verified executable symlinks', async () => {
    const node = join(root, 'node');
    await symlink(process.execPath, node);
    assert.deepEqual(
      await codexPermission(
        runtime,
        event(`${node} ${quote(script)} binding preview --workspace /workspace`),
      ),
      allowed,
    );
    const simpleRoot = join(root, 'simple');
    await symlink(runtime.pluginRoot, simpleRoot);
    assert.deepEqual(
      await codexPermission(
        runtime,
        event(`"${node}" "${simpleRoot}/dist/codex/codex-runtime.js" --help`),
      ),
      allowed,
    );
  });

  it('should approve literal node only when host path selects the executing runtime', async () => {
    const previous = process.env.PATH;
    try {
      process.env.PATH = root;
      const node = join(root, 'node');
      const input = event(
        `'node' ${quote(script)} intake scan --plugin-data ${quote(runtime.pluginData)}`,
      );
      assert.deepEqual(await codexPermission(runtime, input), {});
      await symlink(process.execPath, node);
      assert.deepEqual(await codexPermission(runtime, input), allowed);
      assert.deepEqual(
        await codexPermission(
          runtime,
          event(String(input.tool_input.command).replace(runtime.pluginData, '/other')),
        ),
        {},
      );
      assert.deepEqual(
        await codexPermission(runtime, event(`node ${quote(script + '.other')} intake scan`)),
        {},
      );
      await rm(node);
      await writeFile(node, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      assert.deepEqual(await codexPermission(runtime, input), {});
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  it('should treat a final quoted heredoc as runtime data including shell-looking text', async () => {
    for (const delimiter of ["'REQUEST'", '"REQUEST"']) {
      const input =
        `${command('future-route execute')} <<${delimiter}\n{"text":"$(touch /tmp/nope) ` +
        '`echo data`' +
        ` ; quotes \\" and > redirection"}\nREQUEST\n`;
      assert.deepEqual(await codexPermission(runtime, event(input)), allowed);
    }
  });

  it('should abstain for shell composition, substitutions, wrappers and altered executables', async () => {
    for (const input of [
      `${command()}; /usr/bin/true`,
      `${command()} && /usr/bin/true`,
      `${command()}\n/usr/bin/true`,
      `${command()} | cat`,
      `${command()} > /tmp/out`,
      `${command()} < /tmp/input`,
      `env ${command()}`,
      `NODE_OPTIONS=--inspect ${command()}`,
      `nodejs ${quote(script)} binding inspect`,
      `env node ${quote(script)} binding inspect`,
      `node ${quote(script)} binding inspect; /usr/bin/true`,
      `${quote(process.execPath)} --import /tmp/other.js ${quote(script)} binding inspect`,
      `${quote(process.execPath)} ${quote(script + '.other')} binding inspect`,
      `${command()} $(echo extra)`,
      `${command()} "$(echo extra)"`,
      `${command()} \`echo extra\``,
      `${command()} *`,
      `${command()} # comment`,
      `${command()} <<REQUEST\n{}\nREQUEST`,
      `${command()} <<'REQUEST'\n{}\nREQUEST\n/usr/bin/true`,
      `${command()} <<'REQUEST'\n{}\nREQUEST\n/usr/bin/true\nREQUEST`,
      `${command()} <<'REQUEST'\n{}\nMISSING`,
      `${command()} <<'REQUEST'\n{}\nREQUEST\n\n`,
      `${command()} 'unterminated`,
      `${command()} "\\$HOME"`,
    ])
      assert.deepEqual(await codexPermission(runtime, event(input)), {}, input);
  });

  it('should abstain for other installation data and malformed or unrelated hook events', async () => {
    for (const input of [
      command().replace(quote(runtime.pluginData), '/other/data'),
      command() + ' --plugin-data /other/data',
      command() + ' --plugin-data',
      command() + ' --plugin-data=/other/data',
    ])
      assert.deepEqual(await codexPermission(runtime, event(input)), {});
    for (const input of [
      null,
      {},
      event('git push'),
      { ...event(command()), hook_event_name: 'PreToolUse' },
      { ...event(command()), tool_name: 'mcp__example__run' },
      {
        ...event(command()),
        tool_input: { command: command(), env: { NODE_OPTIONS: '--inspect' } },
      },
    ])
      assert.deepEqual(await codexPermission(runtime, input), {});
  });

  const configureDebug = async (setting: string) => {
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, 'agent.yaml'),
      `schema-version: 1\nagent:\n  id: permission-test\n${setting}\n`,
    );
    await bindCodexWorkspace(runtime.pluginData, workspace, { allowInactive: true });
  };

  it('should follow live debug configuration without changing permission decisions', async () => {
    for (const setting of ['', 'debug: false', 'debug: invalid']) {
      await configureDebug(setting);
      assert.deepEqual(await codexPermission(runtime, event(command())), allowed);
      assert.deepEqual(await codexPermission(runtime, event('git push')), {});
      await assert.rejects(readFile(join(runtime.pluginData, 'permission-request.jsonl')), {
        code: 'ENOENT',
      });
    }
    await configureDebug('debug: true');
    assert.deepEqual(await codexPermission(runtime, event(command())), allowed);
    const path = join(runtime.pluginData, 'permission-request.jsonl');
    const logged = await readFile(path, 'utf8');
    await configureDebug('debug: false');
    assert.deepEqual(await codexPermission(runtime, event(command())), allowed);
    assert.equal(await readFile(path, 'utf8'), logged);
  });

  it('should correlate allow and abstain diagnostics without retaining input content', async () => {
    await configureDebug('debug: true');
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const input = {
      ...event(command() + " <<'DATA'\nprivate-payload\nDATA"),
      session_id: sessionId,
    };
    assert.deepEqual(await codexPermission(runtime, JSON.stringify(input)), allowed);
    assert.deepEqual(await codexPermission(runtime, event('git push private-argument')), {});
    assert.deepEqual(await codexPermission(runtime, 'invalid private-json'), {});
    const path = join(runtime.pluginData, 'permission-request.jsonl');
    const text = await readFile(path, 'utf8');
    const records = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => record.phase),
      ['started', 'decision', 'started', 'decision', 'started', 'decision'],
    );
    assert.deepEqual(
      records.filter((record) => record.phase === 'decision').map((record) => record.decision),
      ['allow', 'abstain', 'abstain'],
    );
    assert.equal(records[0].invocationId, records[1].invocationId);
    assert.notEqual(records[0].invocationId, records[2].invocationId);
    assert.equal(records[0].sessionId, sessionId);
    assert.match(records[0].commandSha256, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(text, /private-|arbitrary provider prose|tool_input|description/u);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it('should restart a full diagnostic log without changing approval or retaining archives', async () => {
    await configureDebug('debug: true');
    const path = join(runtime.pluginData, 'permission-request.jsonl');
    await writeFile(path, 'x'.repeat(1024 * 1024), { mode: 0o600 });
    assert.deepEqual(await codexPermission(runtime, event(command())), allowed);
    const records = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => record.phase),
      ['started', 'decision'],
    );
    assert.equal(records[0].invocationId, records[1].invocationId);
    assert.equal(records[1].decision, 'allow');
    assert.ok((await stat(path)).size < 1024 * 1024);
    assert.deepEqual((await readdir(runtime.pluginData)).sort(), [
      'permission-request.jsonl',
      'workspace-binding.json',
    ]);
  });

  it('should preserve decisions when diagnostics cannot be written', async () => {
    await configureDebug('debug: true');
    await mkdir(join(runtime.pluginData, 'permission-request.jsonl'));
    assert.deepEqual(await codexPermission(runtime, event(command())), allowed);
    assert.deepEqual(await codexPermission(runtime, event('git push')), {});
  });

  it('should leave ordinary runtime execution independent of hook approval and consent', async () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve('dist/codex/codex-runtime.js'),
        'binding',
        'inspect',
        '--plugin-data',
        runtime.pluginData,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'unbound');
    assert.deepEqual(await readdir(root), ["plugin's path with spaces"]);
  });
});
