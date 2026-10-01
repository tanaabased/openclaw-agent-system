import { spawn } from 'node:child_process';

// operational acceptance belongs exclusively to disposable github actions runners.
if (process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('The Codex lifecycle probe is GitHub Actions-only.');
}
const agentId = process.argv[2];
if (!agentId || !/^[a-z0-9-]+$/.test(agentId)) throw new Error('Provide a fixture agent id.');

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function probe(args: string[]): Promise<void> {
  const started = Date.now();
  const child = spawn('openclaw', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let timedOut = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-65_536);
    });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid && groupExists(child.pid)) process.kill(-child.pid, 'SIGKILL');
  }, 30_000);
  let code: number | null;
  try {
    // use exit: close would wait forever for inherited pipes held by a stranded child.
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
  } finally {
    clearTimeout(timer);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const survivingChild = child.pid !== undefined && groupExists(child.pid);
  if (survivingChild && child.pid) process.kill(-child.pid, 'SIGKILL');
  const disposalError =
    /(?:dispos|retir)[^\n]*(?:error|reject|fail)|(?:error|reject|fail)[^\n]*(?:dispos|retir)/i.test(
      output,
    );
  process.stdout.write(
    `${JSON.stringify({ command: args.slice(0, 2), code, elapsedMs: Date.now() - started, timedOut, disposalError, survivingChild })}\n`,
  );
  if (code !== 0 || timedOut || disposalError || survivingChild) {
    throw new Error(
      'Enabled Codex configuration failed clean-exit/process-cleanup acceptance (#135).',
    );
  }
}

await probe([
  'config',
  'set',
  `agents.entries.${agentId}.models`,
  '{"openai/gpt-5.4-nano":{"agentRuntime":{"id":"codex"}}}',
  '--strict-json',
]);
await probe(['config', 'set', `agents.entries.${agentId}.model`, 'openai/gpt-5.4-nano']);
await probe(['config', 'set', `agents.entries.${agentId}.thinkingDefault`, 'medium']);
