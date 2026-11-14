import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

export async function runSync({ run = runCommand } = {}) {
  await run('bun', ['install', '--frozen-lockfile'], { stdio: 'inherit' });
  await run('bun', ['run', 'build'], { stdio: 'inherit' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSync().catch((error) => {
    process.stderr.write(`sync failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
