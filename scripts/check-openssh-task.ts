import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveToolExecutable } from '../lib/tool-cli-runner.ts';
import runCredentialCommand, {
  type CredentialCommandResult,
} from '../utils/run-credential-command.ts';

async function requiredExecutable(name: string): Promise<string> {
  try {
    return await resolveToolExecutable(name, process.env.PATH ?? '');
  } catch {
    throw new Error(`OpenSSH compatibility requires ${name} on PATH.`);
  }
}

function requireSuccess(label: string, result: CredentialCommandResult): void {
  if (result.status !== 'completed' || result.exitCode !== 0) {
    throw new Error(`${label} failed.`);
  }
}

async function waitForSocket(path: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('ssh-agent exited before creating its socket.');
    }
    try {
      if ((await stat(path)).isSocket()) return;
    } catch {
      // The foreground agent creates the socket asynchronously after spawning.
    }
    await delay(20);
  }
  throw new Error('ssh-agent did not create its socket.');
}

async function stopAgent(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolveClosed) => child.once('close', () => resolveClosed()));
  child.kill('SIGTERM');
  if ((await Promise.race([closed.then(() => true), delay(2_000).then(() => false)])) === true) {
    return;
  }
  child.kill('SIGKILL');
  await closed;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-system-ssh-'));
  const keyPath = join(root, 'identity');
  const socketPath = join(root, 'agent.sock');
  const environment = { ...process.env };
  delete environment.SSH_AUTH_SOCK;
  const sshAdd = await requiredExecutable('ssh-add');
  const sshAgent = await requiredExecutable('ssh-agent');
  const sshKeygen = await requiredExecutable('ssh-keygen');
  let agent: ChildProcessWithoutNullStreams | undefined;

  try {
    const generated = await runCredentialCommand({
      args: ['-q', '-t', 'ed25519', '-N', '', '-C', 'agent-system-compatibility', '-f', keyPath],
      command: sshKeygen,
      environment,
      maximumOutputBytes: 65_536,
      timeoutMs: 5_000,
    });
    requireSuccess('ssh-keygen', generated);

    const fingerprintResult = await runCredentialCommand({
      args: ['-l', '-E', 'sha256', '-f', `${keyPath}.pub`],
      command: sshKeygen,
      environment,
      maximumOutputBytes: 65_536,
      timeoutMs: 5_000,
    });
    requireSuccess('ssh-keygen fingerprint lookup', fingerprintResult);
    const fingerprint = fingerprintResult.stdout.toString('utf8').trim().split(/\s+/u)[1];
    assert.match(fingerprint ?? '', /^SHA256:/u, 'ssh-keygen did not return a SHA256 fingerprint.');

    const privateKey = await readFile(keyPath, 'utf8');
    await Promise.all([unlink(keyPath), unlink(`${keyPath}.pub`)]);

    agent = spawn(sshAgent, ['-D', '-a', socketPath], {
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await waitForSocket(socketPath, agent);

    const agentEnvironment = {
      ...environment,
      SSH_ASKPASS_REQUIRE: 'never',
      SSH_AUTH_SOCK: socketPath,
    };
    const added = await runCredentialCommand({
      args: ['-'],
      command: sshAdd,
      environment: agentEnvironment,
      input: privateKey,
      maximumOutputBytes: 65_536,
      timeoutMs: 5_000,
    });
    requireSuccess('ssh-add stdin loading', added);

    const listed = await runCredentialCommand({
      args: ['-l', '-E', 'sha256'],
      command: sshAdd,
      environment: agentEnvironment,
      maximumOutputBytes: 65_536,
      timeoutMs: 5_000,
    });
    requireSuccess('ssh-add fingerprint listing', listed);
    assert.ok(
      listed.stdout.toString('utf8').includes(fingerprint ?? 'unavailable'),
      'ssh-add did not list the generated key fingerprint.',
    );

    await stopAgent(agent);
    await assert.rejects(stat(socketPath), { code: 'ENOENT' });
  } finally {
    if (agent) await stopAgent(agent);
    await rm(root, { recursive: true });
  }

  process.stdout.write('OpenSSH compatibility check: ok\n');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`OpenSSH compatibility check failed: ${message}\n`);
  process.exitCode = 1;
});
