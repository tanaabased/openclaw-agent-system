import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { parse } from 'yaml';

interface CommandResult {
  stderr: string;
  stdout: string;
}

interface InstallResult {
  inspection?: {
    enabled?: boolean;
    installed?: boolean;
  };
  ok?: boolean;
}

interface CacheCheckResult {
  cachePath?: string | null;
  ok?: boolean;
  status?: string;
}

interface PluginManifest {
  name?: string;
  version?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });
  if (code !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${code})\n${stderr}${stdout}`);
  return { stderr, stdout };
}

function skillName(contents: string, directory: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  assert.ok(match, `skill ${directory} must contain YAML frontmatter`);
  const yaml = match[1];
  if (typeof yaml !== 'string') throw new Error(`skill ${directory} must contain YAML frontmatter`);
  const frontmatter = parse(yaml) as unknown;
  assert.ok(record(frontmatter), `skill ${directory} frontmatter must be an object`);
  const name = frontmatter.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`skill ${directory} must declare its name`);
  }
  return name;
}

async function freshSkills(
  codex: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<Set<string>> {
  return new Promise<Set<string>>((resolveSkills, reject) => {
    const child = spawn(codex, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let settled = false;
    const finish = (error?: Error, skills?: Set<string>, signal: NodeJS.Signals = 'SIGTERM') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill(signal);
      if (error) reject(error);
      else resolveSkills(skills ?? new Set());
    };
    const timer = setTimeout(
      () => finish(new Error('fresh Codex skill discovery timed out'), undefined, 'SIGKILL'),
      20_000,
    );
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: unknown;
        try {
          message = JSON.parse(line) as unknown;
        } catch {
          finish(new Error('fresh Codex skill discovery returned malformed JSON'));
          return;
        }
        if (!record(message) || (message.id !== 1 && message.id !== 2)) continue;
        if ('error' in message || !record(message.result)) {
          finish(new Error(`fresh Codex skill discovery request ${String(message.id)} failed`));
          return;
        }
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } });
          continue;
        }
        const entries = Array.isArray(message.result.data)
          ? message.result.data.filter((entry) => record(entry) && entry.cwd === cwd)
          : [];
        if (entries.length !== 1 || !record(entries[0]) || !Array.isArray(entries[0].skills)) {
          finish(new Error('fresh Codex skill discovery omitted the requested directory'));
          return;
        }
        const names = new Set<string>();
        for (const skill of entries[0].skills) {
          if (
            !record(skill) ||
            typeof skill.name !== 'string' ||
            typeof skill.enabled !== 'boolean'
          ) {
            finish(new Error('fresh Codex skill discovery returned a malformed skill record'));
            return;
          }
          if (skill.enabled) names.add(skill.name);
        }
        finish(undefined, names);
      }
    });
    child.once('error', (error) => finish(error));
    child.stdin.once('error', (error) => finish(error));
    child.once('close', () =>
      finish(new Error('Codex app server exited before reporting discovered skills')),
    );
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agent-system-package-test', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

const suppliedArchivePath = process.env.AGENT_SYSTEM_PACKAGE?.trim();
assert.ok(suppliedArchivePath, 'AGENT_SYSTEM_PACKAGE must identify the prepared npm tarball');
const archivePath = await realpath(resolve(suppliedArchivePath));
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-system-codex-plugin-')));

try {
  const extractedRoot = join(temporaryRoot, 'extracted');
  const home = join(temporaryRoot, 'home');
  const codexHome = join(temporaryRoot, 'codex');
  await Promise.all([mkdir(extractedRoot), mkdir(home)]);
  await run('tar', ['-xzf', archivePath, '-C', extractedRoot], {
    cwd: temporaryRoot,
    env: process.env,
  });
  const packageRoot = await realpath(join(extractedRoot, 'package'));
  assert.equal(packageRoot.startsWith(`${temporaryRoot}${sep}`), true);
  const manifest = JSON.parse(
    await readFile(join(packageRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
  ) as PluginManifest;
  assert.equal(manifest.name, 'agent-system');
  assert.equal(typeof manifest.version, 'string');
  assert.notEqual(manifest.version?.trim(), '');

  const skillsRoot = join(packageRoot, 'skills');
  const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(({ name }) => name)
    .sort();
  const expectedSkillNames = new Map<string, string>();
  for (const directory of skillDirectories) {
    const contents = await readFile(join(skillsRoot, directory, 'SKILL.md'), 'utf8');
    expectedSkillNames.set(directory, skillName(contents, directory));
  }
  assert.notEqual(expectedSkillNames.size, 0, 'packaged Codex plugin must contain skills');

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_TOOLS_CODEX_HOME: codexHome,
    NO_COLOR: '1',
    TMPDIR: temporaryRoot,
  };
  const codexTools = resolve('node_modules/.bin/codex-tools');
  const codex = resolve('node_modules/.bin/codex');
  const installed = JSON.parse(
    (
      await run(codexTools, ['install', packageRoot, '--json'], {
        cwd: home,
        env: environment,
      })
    ).stdout,
  ) as InstallResult;
  assert.equal(installed.ok, true);
  assert.equal(installed.inspection?.installed, true);
  assert.equal(installed.inspection?.enabled, true);
  const checked = JSON.parse(
    (
      await run(codexTools, ['cache', 'check', '--repo-root', packageRoot, '--json'], {
        cwd: home,
        env: environment,
      })
    ).stdout,
  ) as CacheCheckResult;
  assert.equal(checked.ok, true);
  assert.equal(checked.status, 'current');
  assert.equal(typeof checked.cachePath, 'string');
  const cacheRoot = await realpath(checked.cachePath!);
  assert.equal(cacheRoot.startsWith(`${codexHome}${sep}`), true);
  for (const [directory] of expectedSkillNames) {
    assert.equal(
      await readFile(join(cacheRoot, 'skills', directory, 'SKILL.md'), 'utf8'),
      await readFile(join(skillsRoot, directory, 'SKILL.md'), 'utf8'),
    );
  }

  const discovered = await freshSkills(codex, environment, home);
  const missing = [...expectedSkillNames.values()]
    .map((name) => `${manifest.name}:${name}`)
    .filter((name) => !discovered.has(name));
  assert.deepEqual(missing, [], `fresh Codex task omitted skills: ${missing.join(', ')}`);
  process.stdout.write(`Codex plugin checks: ok (${expectedSkillNames.size} skills)\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
