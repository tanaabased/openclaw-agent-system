import assert from 'node:assert/strict';

import { runCodexExample } from '../examples/codex/scenario.ts';
import { bindingCommand, commandOutput, parseCodexTrace } from '../examples/codex/trace.ts';

function event(value: unknown): string {
  return JSON.stringify(value);
}

describe('codex example trace', () => {
  it('should reject an unsupported scenario action', async () => {
    await assert.rejects(runCodexExample(['other']), /expected preview, bind, or context/u);
  });

  it('should capture a persistent thread and completed binding command', () => {
    const trace = parseCodexTrace(
      [
        event({ type: 'thread.started', thread_id: 'thread-1' }),
        event({ type: 'turn.started' }),
        event({
          type: 'item.completed',
          item: {
            id: 'item-1',
            type: 'command_execution',
            command:
              "node '/tmp/plugin/dist/codex/codex-runtime.js' binding preview --workspace '/tmp/workspace'",
            aggregated_output: 'diagnostic\n{"status":"ready","workspaceDir":"/tmp/workspace"}\n',
            exit_code: 0,
            status: 'completed',
          },
        }),
        event({ type: 'turn.completed', usage: {} }),
      ].join('\n'),
    );

    assert.equal(trace.threadId, 'thread-1');
    const command = bindingCommand(trace, 'preview');
    assert.equal(command.exitCode, 0);
    assert.deepEqual(commandOutput(command), {
      status: 'ready',
      workspaceDir: '/tmp/workspace',
    });
  });

  it('should reject malformed trace lines and incomplete command events', () => {
    assert.throws(() => parseCodexTrace('{broken'), /line 1 is not valid JSON/u);
    assert.throws(
      () =>
        parseCodexTrace(
          event({
            type: 'item.completed',
            item: { type: 'command_execution', command: 'echo incomplete' },
          }),
        ),
      /must include output/u,
    );
  });

  it('should require one successful packaged command for the selected binding action', () => {
    const failed = parseCodexTrace(
      event({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'node /tmp/plugin/dist/codex/codex-runtime.js binding inspect',
          aggregated_output: '{"status":"error"}\n',
          exit_code: 1,
          status: 'failed',
        },
      }),
    );
    assert.throws(() => bindingCommand(failed, 'inspect'));
    assert.throws(() => bindingCommand(failed, 'bind'), /expected one packaged binding bind/u);
  });
});
