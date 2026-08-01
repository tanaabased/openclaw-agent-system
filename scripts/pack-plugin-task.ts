import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

interface PackResult {
  filename?: string;
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });

  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${code})\n${output}`);
  }

  return output;
}

const positionalArguments = process.argv.slice(2).filter((argument) => argument !== '--');
if (positionalArguments.length !== 1) {
  throw new Error('usage: bun run package:pack -- <output-directory>');
}

const outputArgument = positionalArguments[0];
if (!outputArgument) throw new Error('package output directory is required');

const outputDirectory = isAbsolute(outputArgument)
  ? outputArgument
  : resolve(process.cwd(), outputArgument);
const npmCacheRoot = await mkdtemp(join(tmpdir(), 'openclaw-agent-system-npm-cache-'));

try {
  await mkdir(outputDirectory, { recursive: true });
  await run('bun', ['run', 'build']);
  await run('bun', ['run', 'plugin:check']);

  const packedOutput = await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', outputDirectory],
    {
      env: {
        ...process.env,
        npm_config_cache: npmCacheRoot,
      },
    },
  );
  const result = (JSON.parse(packedOutput) as PackResult[])[0];
  if (!result?.filename) throw new Error('npm pack did not report an archive');

  const archivePath = join(outputDirectory, result.filename);
  await access(archivePath);
  process.stdout.write(`${archivePath}\n`);
} finally {
  await rm(npmCacheRoot, { recursive: true, force: true });
}
