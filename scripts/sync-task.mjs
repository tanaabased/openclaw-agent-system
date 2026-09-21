import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const verificationId =
  'agents/agent-system-sync-verification/environment/AGENT_SYSTEM_SYNC_NONEXISTENT_BINDING';
const providerPath = 'dist/memory-secret-provider-entry.js';

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code ?? 'unknown'}).`));
    });
  });
}

export async function verifyProvider() {
  const request = JSON.stringify({
    ids: [verificationId],
    protocolVersion: 1,
    provider: 'agent-system-environment',
  });
  const child = spawn(process.execPath, [providerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(request);

  const { code, signal } = await completion;
  if (code !== 0 || signal) {
    throw new Error(`Memory provider verification failed (${signal ?? code ?? 'unknown'}).`);
  }

  let response;
  try {
    response = JSON.parse(output);
  } catch {
    throw new Error('Memory provider verification returned invalid JSON.');
  }
  if (
    response?.protocolVersion !== 1 ||
    typeof response.values !== 'object' ||
    response.values === null ||
    Array.isArray(response.values) ||
    Object.keys(response.values).length !== 0 ||
    response.errors?.[verificationId]?.code !== 'NOT_FOUND' ||
    Object.keys(response.errors).length !== 1
  ) {
    throw new Error('Memory provider verification returned an invalid response.');
  }
}

export async function runSync({ run = runCommand, verify = verifyProvider } = {}) {
  await run('bun', ['install', '--frozen-lockfile'], { stdio: 'inherit' });
  await run('bun', ['run', 'build'], { stdio: 'inherit' });
  await verify();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSync().catch((error) => {
    process.stderr.write(`sync failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
