import process from 'node:process';

import { createCodexSessionContext } from './codex-context.ts';

interface SessionStartInput {
  hook_event_name?: unknown;
  source?: unknown;
}

const sessionStartSources = new Set(['startup', 'resume', 'clear', 'compact']);

async function readStandardInput(): Promise<string> {
  let contents = '';
  for await (const chunk of process.stdin) {
    contents += String(chunk);
    if (contents.length > 1024 * 1024) throw new Error('hook input is too large');
  }
  return contents;
}

async function runSessionStart(): Promise<void> {
  const input = JSON.parse(await readStandardInput()) as SessionStartInput;
  if (input.hook_event_name !== 'SessionStart' || typeof input.source !== 'string') {
    throw new Error('expected a SessionStart hook payload');
  }
  if (!sessionStartSources.has(input.source)) throw new Error('unsupported SessionStart source');
  const pluginData = process.env.PLUGIN_DATA;
  if (!pluginData) throw new Error('Codex did not provide the plugin data path');
  const additionalContext = await createCodexSessionContext({
    pluginData,
    source: input.source as 'startup' | 'resume' | 'clear' | 'compact',
  });
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    })}\n`,
  );
}

export async function runCodexRuntime(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (command === 'session-start') return runSessionStart();
  throw new Error('expected session-start command');
}

runCodexRuntime().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown Agent System Codex failure';
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`);
  process.exitCode = 1;
});
