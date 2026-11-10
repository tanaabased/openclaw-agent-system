import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { codexWorkObservationHandoff } from '../agent/codex-dispatch-handoff.ts';

const pending = {
  status: 'observation-required',
  code: 'continuation-turn-state-unresolved',
  request: {
    tool: 'read_thread',
    arguments: { threadId: 'same-chat', turnLimit: 1, includeOutputs: false },
  },
};
const invocation = {
  argv: [
    '/node',
    "/plugin's runtime.js",
    'continuation',
    'context',
    '--plugin-data',
    '/private/data',
  ],
  input: {
    action: 'context',
    decision: { mode: 'work', reasons: ['Keep `$literal`\nunchanged.'] },
  },
};

function fixture() {
  const output: unknown[] = [];
  const calls: string[] = [];
  const commands: Record<string, unknown>[] = [];
  const results: Record<string, unknown>[] = [{ exit_code: 0, output: '{"status":"verified"}' }];
  const tools = {
    mcp__codex_app__read_thread: async (input: unknown) => {
      calls.push('read');
      assert.deepEqual(JSON.parse(JSON.stringify(input)), pending.request.arguments);
      return { isError: false };
    },
    exec_command: async (input: Record<string, unknown>) => {
      calls.push('context');
      commands.push(input);
      return results.shift();
    },
    write_stdin: async (input: { session_id: number }) => {
      calls.push('wait');
      assert.equal(input.session_id, 7);
      return results.shift();
    },
  };
  const response = codexWorkObservationHandoff(pending, invocation) as { nativeHandoff: string };
  const run = () =>
    runInNewContext(`(async () => { ${response.nativeHandoff} })()`, {
      tools,
      text: (item: unknown) => output.push(JSON.parse(JSON.stringify(item))),
    });
  return { tools, output, calls, commands, results, run };
}

describe('agent/codex work observation handoff', () => {
  it('should observe the exact desktop chat once and retry the original semantic invocation', async () => {
    const f = fixture();
    await f.run();
    assert.deepEqual(f.calls, ['read', 'context']);
    const command = f.commands[0]!;
    assert.equal(command.sandbox_permissions, 'require_escalated');
    assert.deepEqual(JSON.parse(JSON.stringify(command.prefix_rule)), invocation.argv);
    assert.equal(
      String(command.cmd).split('\n')[0],
      "'/node' '/plugin'\\''s runtime.js' 'continuation' 'context' '--plugin-data' '/private/data' <<'AGENT_SYSTEM_INPUT'",
    );
    assert.deepEqual(JSON.parse(String(command.cmd).split('\n')[1]!), invocation.input);
  });

  it('should await the same running context command without repeating the read or invocation', async () => {
    const f = fixture();
    f.results.splice(
      0,
      1,
      { session_id: 7, output: '{"status":' },
      { exit_code: 0, output: '"verified"}' },
    );
    await f.run();
    assert.deepEqual(f.calls, ['read', 'context', 'wait']);
    assert.deepEqual(f.output.at(-1), { exit_code: 0, output: '{"status":"verified"}' });
  });

  it('should explain missing desktop tools without invoking the transition', async () => {
    const f = fixture();
    Reflect.deleteProperty(f.tools, 'mcp__codex_app__read_thread');
    await f.run();
    assert.deepEqual(f.calls, []);
    assert.equal(
      (f.output[0] as { code: string }).code,
      'continuation-native-observation-unavailable',
    );
  });

  it('should stop on native read errors or actual native denial', async () => {
    const f = fixture();
    f.tools.mcp__codex_app__read_thread = async () => ({ isError: true });
    await f.run();
    assert.equal(f.commands.length, 0);
    assert.equal(
      (f.output.at(-1) as { code: string }).code,
      'continuation-native-observation-failed',
    );
    f.tools.mcp__codex_app__read_thread = async () => {
      throw new Error('user rejected MCP tool call');
    };
    await assert.rejects(f.run(), /user rejected MCP tool call/);
    assert.equal(f.commands.length, 0);
  });

  it('should not replay the command after execution denial or incomplete receipt evidence', async () => {
    for (const result of [
      { exit_code: 1, output: 'native approval denied' },
      { exit_code: 0, output: JSON.stringify(pending) },
    ]) {
      const f = fixture();
      f.results.splice(0, 1, result);
      await f.run();
      assert.deepEqual(f.calls, ['read', 'context']);
      if (result.exit_code === 0)
        assert.equal(
          (f.output.at(-1) as { reason: string }).reason,
          'native-observation-receipt-unavailable',
        );
      else assert.deepEqual(f.output.at(-1), result);
    }
  });

  it('should not prepare another read for superseded evidence, denial or unrelated operations', () => {
    for (const response of [
      { ...pending, reason: 'native-observation-superseded' },
      { ...pending, code: 'continuation-native-approval-denied' },
      { status: 'verified' },
    ])
      assert.equal(codexWorkObservationHandoff(response, invocation), response);
    assert.equal(
      codexWorkObservationHandoff(pending, { ...invocation, input: { action: 'result' } }),
      pending,
    );
  });
});
