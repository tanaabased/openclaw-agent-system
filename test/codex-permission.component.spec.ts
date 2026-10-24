import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import codexPermission from '../agent/codex-permission.ts';

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

  it('should delegate present and future runtime operations without a second registry or state', async () => {
    const before = await readdir(root);
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
    assert.deepEqual(await readdir(root), before);
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
      `node ${quote(script)} binding inspect`,
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
