import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Keep prompts, tool arguments, callback commands, and trust hashes out of CI logs.
export function hookDiagnostic(message) {
  if (['thread/start', 'thread/resume'].includes(message?.method)) {
    const config = message.params?.config ?? {};
    return {
      method: message.method,
      hooksEnabled: config['features.hooks'] ?? config.features?.hooks ?? null,
      stopHandlers: (config['hooks.Stop'] ?? config.hooks?.Stop ?? []).reduce(
        (count, group) => count + (group.hooks?.length ?? 0),
        0,
      ),
      stopTrustEntries: Object.entries(config['hooks.state'] ?? config.hooks?.state ?? {})
        .filter(([key]) => key.endsWith(':stop:0:0'))
        .map(([, state]) => ({
          enabled: state.enabled === true,
          trusted: Boolean(state.trusted_hash),
        })),
    };
  }
  if (!['hook/started', 'hook/completed'].includes(message?.method)) return;
  const run = message.params?.run ?? {};
  const details = JSON.stringify(run.entries ?? []);
  return {
    method: message.method,
    stop: run.eventName === 'stop',
    status: ['running', 'completed', 'failed', 'blocked', 'stopped'].includes(run.status)
      ? run.status
      : 'other',
    durationMs: typeof run.durationMs === 'number' ? run.durationMs : null,
    entryCount: Array.isArray(run.entries) ? run.entries.length : 0,
    signals: [
      'timeout',
      'timed out',
      'not found',
      'permission denied',
      'unavailable',
      'connection refused',
      'invalid',
      'stale',
      'failed',
    ].filter((signal) => details.toLowerCase().includes(signal)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.COMMAND_CHAT_HOOK_TRACE_PATH) {
    throw new Error(
      'This diagnostic entrypoint requires the isolated hosted command-chat scenario.',
    );
  }
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../node_modules/@openai/codex/bin/codex.js', import.meta.url)),
      ...process.argv.slice(2),
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  for (const stream of [process.stdin, child.stdout]) {
    createInterface({ input: stream }).on('line', (line) => {
      try {
        const diagnostic = hookDiagnostic(JSON.parse(line));
        if (diagnostic)
          appendFileSync(
            process.env.COMMAND_CHAT_HOOK_TRACE_PATH,
            JSON.stringify({ pid: process.pid, ...diagnostic }) + '\n',
          );
      } catch {
        // Observation must not alter the native protocol or turn a failure into success.
      }
    });
  }
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => process.exit(1));
  child.on('close', (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}
