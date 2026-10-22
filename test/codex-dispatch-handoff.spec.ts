import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import codexDispatchHandoff, { codexNativeHandoff } from '../agent/codex-dispatch-handoff.ts';

const runtime = {
  nodeExecutable: '/node',
  entrypoint: "/plugin's runtime.js",
  pluginData: '/private/data',
};
const request = {
  prompt: 'Keep every clause.\n`$quoted` "text"',
  title: '#42: POEM',
  model: 'model',
  thinking: 'medium',
  target: { type: 'project', projectId: 'project', environment: { type: 'worktree' } },
};
const prepared = { status: 'prepared', id: 'receipt', request };
const routing = { status: 'routing-required', id: 'record-id', digest: 'different-digest' };
const success = (value: unknown) => ({ exit_code: 0, output: JSON.stringify(value) });
const access = { exit_code: 1, output: '{"code":"codex-host-access-required"}' };
const busy = { exit_code: 0, output: '{"status":"busy"}' };
const lockBusy = { exit_code: 1, output: '{"code":"private-state-file-lock-busy"}' };

function fixture(results: (Record<string, unknown> | Error)[], failCreation = false) {
  const commands: Record<string, unknown>[] = [];
  const polls: Record<string, unknown>[] = [];
  const creations: unknown[] = [];
  const output: unknown[] = [];
  const retained = new Map<string, unknown>();
  const context = {
    runtimeRoute: 'dispatch',
    runtimeInput: {} as Record<string, unknown>,
    tools: {
      exec_command: async (input: Record<string, unknown>) => {
        commands.push(input);
        assert.ok(results.length);
        const result = results.shift();
        if (result instanceof Error) throw result;
        return result;
      },
      write_stdin: async (input: Record<string, unknown>) => {
        polls.push(input);
        assert.ok(results.length);
        return results.shift();
      },
      mcp__codex_app__create_thread: async (input: unknown) => {
        creations.push(input);
        if (failCreation) throw new Error('native rejection');
        return { threadId: 'child' };
      },
      mcp__codex_app__send_message_to_thread: async (input: unknown) => {
        creations.push(input);
        if (failCreation) throw new Error('native rejection');
        return {};
      },
    },
    store: (key: string, value: unknown) => retained.set(key, value),
    load: (key: string) => retained.get(key),
    text: (value: unknown) => output.push(value),
    setTimeout: (callback: () => void) => callback(),
  };
  const execute = (input: Record<string, unknown> = { action: 'next' }, route = 'dispatch') => {
    context.runtimeRoute = route;
    context.runtimeInput = input;
    return runInNewContext('(async () => {' + codexDispatchHandoff(runtime) + '})()', context);
  };
  const send = (route: 'dispatch' | 'continuation' = 'dispatch') =>
    runInNewContext(
      '(async () => {' + codexNativeHandoff(runtime.pluginData, route) + '})()',
      context,
    );
  return { execute, send, commands, polls, creations, output };
}

describe('agent/codex-dispatch-handoff', () => {
  it('should carry distinct routing identifiers into preparation without transcription', async () => {
    const test = fixture([success(routing), success(prepared)]);
    await test.execute();
    await test.execute({ action: 'prepare', title: 'poem', assessment: { complexity: 'low' } });
    const input = JSON.parse(String(test.commands[1]!.cmd).split('\n')[1]!);
    assert.equal(input.id, 'record-id');
    assert.equal(input.digest, 'different-digest');
    assert.equal(input.title, 'poem');
    assert.equal(test.creations.length, 0);
    await test.send();
    assert.deepEqual(JSON.parse(JSON.stringify(test.creations)), [request]);
    await assert.rejects(test.send(), /prepared-request-unavailable/);
  });

  it('should reject supplied identifiers and missing or replaced routing evidence', async () => {
    for (const extra of [
      { id: 'different-digest' },
      { digest: 'record-id' },
      { model: 'override' },
    ]) {
      const test = fixture([success(routing)]);
      await test.execute();
      await assert.rejects(test.execute({ action: 'prepare', ...extra }), /routing-input-invalid/);
      assert.equal(test.commands.length, 1);
    }
    const test = fixture([success(routing), success({ status: 'idle' })]);
    await assert.rejects(test.execute({ action: 'prepare' }), /routing-evidence-unavailable/);
    await test.execute();
    await test.execute();
    await assert.rejects(test.execute({ action: 'prepare' }), /routing-evidence-unavailable/);
    assert.equal(test.commands.length, 2);
  });

  it('should preserve host access and the exact request across both forms of busy result', async () => {
    for (const [route, input] of [
      ['intake', { action: 'scan' }],
      ['dispatch', { action: 'next', projects: [], threads: {} }],
      ['dispatch', { action: 'reconcile', id: 'receipt' }],
      ['dispatch', { action: 'report', automationId: 'job', currentTimeIso: 'now' }],
      ['continuation', { action: 'next' }],
      ['feedback', { action: 'reconcile', id: 'owner', eventId: 'event' }],
    ] as const) {
      const test = fixture([access, lockBusy, busy, success({ status: 'idle' })]);
      await test.execute(input, route);
      assert.equal(test.commands.length, 4);
      assert.equal(new Set(test.commands.map((command) => command.cmd)).size, 1);
      assert.equal(test.commands[0]!.sandbox_permissions, undefined);
      assert.ok(
        test.commands
          .slice(1)
          .every((command) => command.sandbox_permissions === 'require_escalated'),
      );
      assert.equal(test.creations.length, 0);
    }
  });

  it('should retry preparation without losing retained routing evidence', async () => {
    const test = fixture([success(routing), access, lockBusy, success(prepared)]);
    await test.execute();
    await test.execute({ action: 'prepare', title: 'poem', assessment: {} });
    assert.equal(new Set(test.commands.slice(1).map((command) => command.cmd)).size, 1);
    await test.send();
    assert.equal(test.creations.length, 1);
  });

  it('should await complete output and never combine preparation with a native handoff', async () => {
    const json = JSON.stringify(prepared);
    const test = fixture([
      { session_id: 42, output: json.slice(0, 40) },
      { session_id: 42, output: json.slice(40, 80) },
      { exit_code: 0, output: json.slice(80) },
    ]);
    await test.execute({ action: 'next' }, 'continuation');
    assert.deepEqual(
      test.polls.map((poll) => poll.session_id),
      [42, 42],
    );
    assert.equal(test.commands.length, 1);
    assert.match(String(test.commands[0]!.cmd), /'\/plugin'\\''s runtime\.js'/u);
    assert.equal(test.creations.length, 0);
    assert.equal(test.output.length, 1);
    await test.send('continuation');
    assert.deepEqual(JSON.parse(JSON.stringify(test.creations)), [request]);
  });

  it('should clear old handoffs on failures and stop immediately on native rejection', async () => {
    for (const result of [
      { exit_code: 1, output: 'native approval denied' },
      { exit_code: 0, output: 'truncated json' },
      { exit_code: 1, output: JSON.stringify(prepared) },
      new Error('native rejection'),
    ]) {
      const test = fixture([success(prepared), result]);
      await test.execute();
      await assert.rejects(test.execute());
      await assert.rejects(test.send(), /prepared-request-unavailable/);
      assert.equal(test.commands.length, 2);
      assert.equal(test.creations.length, 0);
    }
    const test = fixture([access, new Error('native rejection'), success(prepared)]);
    await assert.rejects(test.execute(), /native rejection/);
    assert.equal(test.commands.length, 2);
  });

  it('should retain only operation identity for evidence reconciliation after a refused preparation', async () => {
    const test = fixture([
      success(routing),
      access,
      new Error('native rejection'),
      success({ status: 'blocked', nextAction: 'next' }),
    ]);
    await test.execute();
    await assert.rejects(
      test.execute({ action: 'prepare', title: 'poem', assessment: {} }),
      /native rejection/,
    );
    await assert.rejects(test.send(), /prepared-request-unavailable/);
    await test.execute({ action: 'reconcile' });
    const input = JSON.parse(String(test.commands.at(-1)!.cmd).split('\n')[1]!);
    assert.deepEqual(input, { action: 'reconcile', id: routing.id });
    assert.equal(test.commands.length, 4);
    assert.equal(test.creations.length, 0);
  });

  it('should reconcile a refused creation without resending its consumed handoff', async () => {
    const test = fixture(
      [success(prepared), success({ status: 'blocked', nextAction: 'next' })],
      true,
    );
    await test.execute();
    await assert.rejects(test.send(), /native rejection/);
    await test.execute({ action: 'reconcile' });
    const input = JSON.parse(String(test.commands.at(-1)!.cmd).split('\n')[1]!);
    assert.deepEqual(input, { action: 'reconcile', id: prepared.id });
    await assert.rejects(test.send(), /prepared-request-unavailable/);
    assert.equal(test.creations.length, 1);
  });

  it('should bound busy and access retries without retaining a sendable request', async () => {
    for (const results of [
      [busy, lockBusy, busy, lockBusy],
      [access, access],
    ]) {
      const test = fixture(results.slice());
      if (results[0] === access) await assert.rejects(test.execute(), /preparation-failed/);
      else await test.execute();
      assert.equal(test.commands.length, results.length);
      await assert.rejects(test.send(), /prepared-request-unavailable/);
    }
  });

  it('should never send twice after uncertain creation or continuation', async () => {
    for (const route of ['dispatch', 'continuation'] as const) {
      const test = fixture([success(prepared)], true);
      await test.execute({ action: 'next' }, route);
      await assert.rejects(test.send(route), /native rejection/);
      await assert.rejects(test.send(route), /prepared-request-unavailable/);
      assert.equal(test.creations.length, 1);
    }
  });

  it('should keep publication and unsupported routes out of scheduled preparation', async () => {
    const test = fixture([]);
    await assert.rejects(test.execute({ action: 'publish' }, 'delivery'), /action-unsupported/);
    await assert.rejects(test.execute({ action: 'publish' }, 'feedback'), /action-unsupported/);
    assert.equal(test.commands.length, 0);
  });
});
