import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import AgentSystemToolError from '../../api/error.ts';
import type { AgentSystemOperation } from '../../api/types.ts';
import isPathContained from '../../utils/is-path-contained.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';
import { googleCommandContract } from './command-contract.ts';
import type { GoogleToolInput } from './tool-schema.ts';

const commonFlags: Record<string, 'boolean' | 'value'> = {
  '--json': 'boolean',
  '--plain': 'boolean',
  '--results-only': 'boolean',
  '--select': 'value',
  '--dry-run': 'boolean',
  '--force': 'boolean',
  '--readonly': 'boolean',
};

function invalid(): never {
  throw new AgentSystemToolError(
    'invalid_arguments',
    'Google command, flag, or file path is outside the supported managed surface. See the Google tool guide.',
  );
}

/** Parse only reviewed canonical commands; rebuild argv so data cannot become global flags. */
export function parseGoogleCommand(input: GoogleToolInput) {
  if (
    !input.argv.length ||
    input.argv.length > 256 ||
    input.argv.some((value) => value.includes('\0')) ||
    Buffer.byteLength(input.stdin ?? '') > 65536
  )
    invalid();
  const command = Object.keys(googleCommandContract)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => candidate.split(' ').every((part, index) => input.argv[index] === part));
  if (!command) invalid();
  const contract = googleCommandContract[command]!;
  const flags = { ...commonFlags, ...contract.flags };
  const normalized: string[] = [];
  const positionals: string[] = [];
  const paths: Array<{ value: string; mode: 'read' | 'write' }> = [];
  let positionalOnly = false;
  for (let index = command.split(' ').length; index < input.argv.length; index++) {
    const argument = input.argv[index]!;
    if (argument === '--' && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (!argument.startsWith('-') || argument === '-' || positionalOnly) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    const kind = Object.hasOwn(flags, flag) ? flags[flag] : undefined;
    if (!kind) invalid();
    if (kind === 'boolean') {
      if (equals >= 0 && !['true', 'false'].includes(argument.slice(equals + 1))) invalid();
      normalized.push(argument);
      continue;
    }
    const value = equals < 0 ? input.argv[++index] : argument.slice(equals + 1);
    if (value === undefined) invalid();
    if (kind === 'read' || kind === 'write') paths.push({ value, mode: kind });
    else if (value.startsWith('@')) invalid();
    normalized.push(`${flag}=${value}`);
  }
  positionals.forEach((value, index) => {
    if (contract.arguments[index] === 'read') paths.push({ value, mode: 'read' });
  });
  if (
    Object.values(contract.flags).includes('write') &&
    !paths.some((path) => path.mode === 'write')
  )
    invalid();
  // native downloads must use an explicit file rather than config-owned default directories.
  if (command === 'gmail attachment' && normalized.some((flag) => /^--name=.*[/\\]/u.test(flag)))
    invalid();
  return {
    command,
    paths,
    argv: [
      ...command.split(' '),
      ...normalized,
      ...(positionals.length ? ['--', ...positionals] : []),
    ],
  };
}

export function classifyGoogleCommand(input: GoogleToolInput): AgentSystemOperation {
  const { command } = parseGoogleCommand(input);
  return {
    action: command.replaceAll(' ', '.'),
    risk: googleCommandContract[command]!.risk,
    summary: `Run Google ${command}.`,
  };
}

/** Admit regular input files and explicit output files inside trusted canonical roots. */
export async function validateGoogleFiles(
  input: GoogleToolInput,
  cwd: string,
  roots: readonly string[],
): Promise<void> {
  const admitted = (
    await Promise.all(roots.map((path) => realpath(path).catch(() => undefined)))
  ).filter((path): path is string => path !== undefined);
  for (const { value, mode } of parseGoogleCommand(input).paths) {
    if (value === '-' && mode === 'read') continue;
    if (!value || value.startsWith('~') || value.includes(',') || /^[a-z]+:\/\//iu.test(value))
      invalid();
    const path = isAbsolute(value) ? value : resolve(cwd, value);
    const parent = await realpath(dirname(path)).catch(() => invalid());
    if (!admitted.some((root) => isPathContained(root, parent))) invalid();
    const target = join(parent, basename(path));
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) invalid();
    } catch (error) {
      if (mode !== 'write' || nodeErrorCode(error) !== 'ENOENT') throw error;
    }
  }
}
