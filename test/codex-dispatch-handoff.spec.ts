import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import codexDispatchHandoff from '../agent/codex-dispatch-handoff.ts';

const runtime = {
  nodeExecutable: '/node',
  entrypoint: "/plugin's runtime.js",
  pluginData: '/private/data',
};
const request = {
  prompt:
    'Keep every clause; if functions.exec yields a running cell_id, resume it with functions.wait.\n`$quoted` "text"',
  title: '#42: POEM',
  model: 'model',
  thinking: 'medium',
  target: { type: 'project', projectId: 'project', environment: { type: 'worktree' } },
};
const prepared = { status: 'prepared', id: 'receipt', request };

function fixture(
  results: Record<string, unknown>[],
  failCreation = false,
  route: 'dispatch' | 'continuation' = 'dispatch',
) {
  const commands: Record<string, unknown>[] = [];
  const polls: Record<string, unknown>[] = [];
  const creations: unknown[] = [];
  const output: unknown[] = [];
  const execute = () =>
    runInNewContext('(async () => {' + codexDispatchHandoff(runtime, route) + '})()', {
      prepareInput: { action: 'prepare', id: 'receipt', title: 'poem', assessment: {} },
      tools: {
        exec_command: async (input: Record<string, unknown>) => {
          commands.push(input);
          assert.ok(results.length);
          return results.shift();
        },
        write_stdin: async (input: Record<string, unknown>) => {
          polls.push(input);
          assert.ok(results.length);
          return results.shift();
        },
        [route === 'dispatch'
          ? 'mcp__codex_app__create_thread'
          : 'mcp__codex_app__send_message_to_thread']: async (input: unknown) => {
          creations.push(input);
          if (failCreation) throw new Error('native rejection');
          return { threadId: 'child' };
        },
      },
      text: (value: unknown) => output.push(value),
      setTimeout: (callback: () => void) => callback(),
    });
  return { execute, commands, polls, creations, output };
}

describe('agent/codex-dispatch-handoff', () => {
  it('should send the complete continuation request once without transcribing its receipt', async () => {
    const continuation = {
      threadId: 'issue',
      model: 'model',
      thinking: 'medium',
      prompt: 'Continue. Receipt: ' + 'e'.repeat(63) + '5.',
    };
    const test = fixture(
      [{ exit_code: 0, output: JSON.stringify({ ...prepared, request: continuation }) }],
      false,
      'continuation',
    );
    await test.execute();
    assert.deepEqual(JSON.parse(JSON.stringify(test.creations)), [continuation]);
    assert.match(String(test.commands[0]!.cmd), /'continuation'/);
    const rejected = fixture(
      [{ exit_code: 0, output: JSON.stringify(prepared) }],
      true,
      'continuation',
    );
    await assert.rejects(rejected.execute(), /native rejection/);
    assert.equal(rejected.creations.length, 1);
  });
  it('should pass every prepared field directly after polling the same command', async () => {
    const json = JSON.stringify(prepared);
    const test = fixture([
      { session_id: 42, output: json.slice(0, 40) },
      { session_id: 42, output: json.slice(40, 80) },
      { exit_code: 0, output: json.slice(80) },
    ]);
    await test.execute();
    assert.equal(test.commands.length, 1);
    assert.deepEqual(
      test.polls.map((poll) => poll.session_id),
      [42, 42],
    );
    assert.deepEqual(JSON.parse(JSON.stringify(test.creations)), [request]);
    assert.match(String(test.commands[0]!.cmd), /'\/plugin'\\''s runtime\.js'/u);
    assert.equal(test.output.length, 2);
  });

  it('should retry host access once with the identical command before creating', async () => {
    const test = fixture([
      { exit_code: 1, output: '{"code":"codex-host-access-required"}' },
      { exit_code: 0, output: JSON.stringify(prepared) },
    ]);
    await test.execute();
    assert.equal(test.commands.length, 2);
    assert.equal(test.commands[1]!.cmd, test.commands[0]!.cmd);
    assert.equal(test.commands[1]!.sandbox_permissions, 'require_escalated');
    assert.equal(test.creations.length, 1);
  });

  it('should stop on a completed failure or malformed output without creating', async () => {
    for (const result of [
      { exit_code: 1, output: 'native approval denied' },
      { exit_code: 0, output: 'truncated json' },
      { exit_code: 1, output: JSON.stringify(prepared) },
    ]) {
      const test = fixture([result]);
      await assert.rejects(test.execute());
      assert.equal(test.commands.length, 1);
      assert.equal(test.creations.length, 0);
      assert.equal(test.output.length, 1);
    }
  });

  it('should never create for retained or unresolved preparation', async () => {
    for (const status of ['reconcile-required', 'creating', 'blocked', 'budget-exhausted']) {
      const test = fixture([{ exit_code: 0, output: JSON.stringify({ ...prepared, status }) }]);
      await test.execute();
      assert.equal(test.creations.length, 0);
    }
  });

  it('should bound busy retries and never repeat an uncertain native creation', async () => {
    const busy = { exit_code: 0, output: '{"status":"busy"}' };
    const test = fixture([busy, busy, busy, busy]);
    await test.execute();
    assert.equal(test.commands.length, 4);
    assert.equal(test.creations.length, 0);
    const rejected = fixture([{ exit_code: 0, output: JSON.stringify(prepared) }], true);
    await assert.rejects(rejected.execute(), /native rejection/u);
    assert.equal(rejected.commands.length, 1);
    assert.equal(rejected.creations.length, 1);
  });
});
