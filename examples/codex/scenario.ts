import assert from 'node:assert/strict';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { bindingCommand, commandOutput, parseCodexTrace } from './trace.ts';

interface ScenarioState {
  primaryWorkspace?: string;
  threadId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

async function state(path: string): Promise<ScenarioState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    assert.ok(record(value), 'scenario state must be an object');
    return value as ScenarioState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function saveState(path: string, value: ScenarioState): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function findFiles(root: string, name: string): Promise<string[]> {
  const matches: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name === name) matches.push(path);
      }),
    );
  }
  await visit(root);
  return matches.sort();
}

async function checkPreview(args: string[]): Promise<void> {
  const trace = parseCodexTrace(await readFile(option(args, '--trace'), 'utf8'));
  assert.ok(trace.threadId, 'preview trace must start a persistent thread');
  const workspace = await realpath(option(args, '--workspace'));
  const result = commandOutput(bindingCommand(trace, 'preview'));
  assert.equal(result.status, 'ready');
  assert.equal(result.workspaceDir, workspace);
  assert.ok(record(result.manifest));
  assert.equal(result.manifest.status, 'valid');
  assert.equal(result.manifest.agentId, 'codex-example');
  assert.deepEqual(
    await findFiles(option(args, '--codex-home'), 'workspace-binding.json'),
    [],
    'preview must not persist a binding',
  );
  await saveState(option(args, '--state'), {
    primaryWorkspace: workspace,
    threadId: trace.threadId,
  });
}

async function checkBind(args: string[]): Promise<void> {
  const trace = parseCodexTrace(await readFile(option(args, '--trace'), 'utf8'));
  const bindResult = commandOutput(bindingCommand(trace, 'bind'));
  assert.equal(bindResult.status, 'bound');
  const inspection = commandOutput(bindingCommand(trace, 'inspect'));
  assert.equal(inspection.status, 'bound');
  assert.ok(record(inspection.binding));
  const current = await state(option(args, '--state'));
  assert.equal(inspection.binding.workspaceDir, current.primaryWorkspace);
  assert.ok(record(inspection.preview));
  assert.ok(record(inspection.preview.manifest));
  assert.equal(inspection.preview.manifest.agentId, 'codex-example');
  const bindingFiles = await findFiles(option(args, '--codex-home'), 'workspace-binding.json');
  assert.equal(bindingFiles.length, 1, 'confirmed bind must persist one binding');
}

async function checkContext(args: string[]): Promise<void> {
  const trace = parseCodexTrace(await readFile(option(args, '--trace'), 'utf8'));
  assert.deepEqual(trace.commands, [], 'fresh context assertion must not execute commands');
  const response = JSON.parse(await readFile(option(args, '--response'), 'utf8')) as unknown;
  assert.ok(record(response));
  const current = await state(option(args, '--state'));
  assert.equal(response.agentId, 'codex-example');
  assert.equal(response.workspaceDir, current.primaryWorkspace);
}

export async function runCodexExample(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  const options = args.slice(1);
  if (command === 'preview') return checkPreview(options);
  if (command === 'bind') return checkBind(options);
  if (command === 'context') return checkContext(options);
  throw new Error('expected preview, bind, or context');
}

if (process.argv[1]?.endsWith(`${sep}scenario.ts`)) {
  runCodexExample().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
