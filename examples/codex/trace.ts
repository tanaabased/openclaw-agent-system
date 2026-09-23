import assert from 'node:assert/strict';

export interface CodexCommandExecution {
  command: string;
  exitCode: number | null;
  output: string;
  status: string;
}

export interface CodexTrace {
  commands: CodexCommandExecution[];
  threadId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCodexTrace(contents: string): CodexTrace {
  const trace: CodexTrace = { commands: [] };
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Codex trace line ${index + 1} is not valid JSON`);
    }
    if (!record(event) || typeof event.type !== 'string') {
      throw new Error(`Codex trace line ${index + 1} is not an event`);
    }
    if (event.type === 'thread.started') {
      if (typeof event.thread_id !== 'string') {
        throw new Error('thread.started must include thread_id');
      }
      trace.threadId = event.thread_id;
      continue;
    }
    if (event.type !== 'item.completed' || !record(event.item)) continue;
    const item = event.item;
    if (item.type !== 'command_execution') continue;
    if (typeof item.command !== 'string') {
      throw new Error('command execution must include command');
    }
    if (typeof item.aggregated_output !== 'string') {
      throw new Error('command execution must include output');
    }
    assert.ok(
      typeof item.exit_code === 'number' || item.exit_code === null,
      'command execution must include exit_code',
    );
    if (typeof item.status !== 'string') {
      throw new Error('command execution must include status');
    }
    trace.commands.push({
      command: item.command,
      exitCode: item.exit_code,
      output: item.aggregated_output,
      status: item.status,
    });
  }
  return trace;
}

export function commandOutput(command: CodexCommandExecution): Record<string, unknown> {
  for (const line of command.output.trim().split(/\r?\n/u).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (record(parsed)) return parsed;
    } catch {
      // Ignore diagnostics surrounding the one machine-readable result.
    }
  }
  throw new Error(`Codex command did not return a JSON object: ${command.command}`);
}

export function bindingCommand(
  trace: CodexTrace,
  action: 'bind' | 'inspect' | 'preview',
): CodexCommandExecution {
  const matches = trace.commands.filter(
    ({ command }) =>
      command.includes('dist/codex/codex-runtime.js') &&
      new RegExp(`\\bbinding\\b[\\s\\S]*\\b${action}\\b`, 'u').test(command),
  );
  assert.equal(matches.length, 1, `expected one packaged binding ${action} command`);
  const match = matches[0]!;
  assert.equal(match.status, 'completed');
  assert.equal(match.exitCode, 0);
  return match;
}
