import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

import AgentSystemToolError from '../../api/error.ts';
import graphqlAssignmentEffects from './assignment-graphql.ts';
import { resolveGitHubCommand } from './policy.ts';
import type { GitHubToolInput } from './tool-schema.ts';

export interface AssignmentEffect {
  mode: 'add' | 'remove' | 'replace';
  members: string[];
  identity: 'login' | 'node';
  target?: { rest: string } | { node: string };
}

export const selfUnassignmentMessage =
  'GitHub self-unassignment is not permitted through Agent System. An operator or another authorized user must reassign this work.';

export function assignmentInputError(): never {
  throw new AgentSystemToolError(
    'invalid_arguments',
    'The GitHub assignment request cannot be inspected. Provide an unambiguous command or JSON/GraphQL payload with readable assignment inputs and retry.',
  );
}

const apiValueOptions = new Set([
  '--cache',
  '--field',
  '--header',
  '--hostname',
  '--input',
  '--jq',
  '--method',
  '--preview',
  '--raw-field',
  '--template',
  '-F',
  '-H',
  '-p',
  '-X',
  '-f',
  '-q',
  '-t',
]);
const editValueOptions = new Set([
  '--repo',
  '-R',
  '--add-assignee',
  '--remove-assignee',
  '--add-label',
  '--remove-label',
  '--add-project',
  '--remove-project',
  '--add-reviewer',
  '--remove-reviewer',
  '--base',
  '-B',
  '--body',
  '-b',
  '--body-file',
  '-F',
  '--milestone',
  '-m',
  '--title',
  '-t',
]);

interface Arguments {
  options: Array<{ name: string; value: string; index: number; count: number; prefix?: string }>;
  positional: string[];
  help: boolean;
}

function argumentsFor(argv: readonly string[], valueOptions: Set<string>): Arguments {
  const options: Arguments['options'] = [];
  const positional: string[] = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    const equal = token.indexOf('=');
    const longName = equal > 0 ? token.slice(0, equal) : token;
    // pflag accepts the api's boolean -i before a value-taking shorthand, e.g. -iXPATCH.
    const shortOffset =
      valueOptions === apiValueOptions && /^-i[^-]/u.test(token)
        ? 1 + (token.slice(1).match(/^i+/u)?.[0].length ?? 0)
        : 1;
    const shortName = `-${token[shortOffset] ?? ''}`;
    const name = valueOptions.has(longName)
      ? longName
      : token.startsWith('-') && !token.startsWith('--') && valueOptions.has(shortName)
        ? shortName
        : undefined;
    if (name) {
      const consumed = name.startsWith('--') ? name.length : shortOffset + 1;
      const attached = token.length > consumed;
      const value = attached
        ? token.slice(consumed + (token[consumed] === '=' ? 1 : 0))
        : argv[index + 1];
      if (value === undefined) assignmentInputError();
      options.push({
        name,
        value,
        index,
        count: attached ? 1 : 2,
        ...(shortOffset > 1 && !name.startsWith('--')
          ? { prefix: token.slice(0, shortOffset) }
          : {}),
      });
      if (!attached) index += 1;
    } else if (!token.startsWith('-')) positional.push(token);
  }
  return { options, positional, help };
}

/** parse actual edit options, never text carried by another option. */
export function cliAssignmentRemovals(input: GitHubToolInput): AssignmentEffect[] {
  const { command, position } = resolveGitHubCommand(input.argv);
  if (command !== 'issue' && command !== 'pr') return [];
  const parsed = argumentsFor(input.argv.slice(position + 1), editValueOptions);
  if (parsed.help || parsed.positional[0] !== 'edit') return [];
  return parsed.options
    .filter((option) => option.name === '--remove-assignee')
    .map((option) => ({
      mode: 'remove',
      identity: 'login',
      members: option.value
        .split(',')
        .map((member) => member.trim().replace(/^"|"$/gu, '').trim())
        .filter(Boolean),
    }));
}

export function rejectObviousSelfRemoval(input: GitHubToolInput, username?: string): void {
  if (
    cliAssignmentRemovals(input).some((effect) =>
      effect.members.some(
        (member) =>
          member === '@me' || (username && member.toLowerCase() === username.toLowerCase()),
      ),
    )
  ) {
    throw new AgentSystemToolError('invalid_arguments', selfUnassignmentMessage);
  }
}

async function readInput(path: string, cwd: string, stdin?: string): Promise<string> {
  if (path === '-') return stdin ?? assignmentInputError();
  try {
    const file = await open(resolve(cwd, path), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) return assignmentInputError();
      const buffer = Buffer.alloc(65_537);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > 65_536) return assignmentInputError();
      return buffer.subarray(0, length).toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return assignmentInputError();
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return assignmentInputError();
  return value as Record<string, unknown>;
}

function members(value: unknown): string[] {
  if (value === null || value === '') return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    return assignmentInputError();
  return value;
}

function setField(payload: Record<string, unknown>, key: string, value: unknown): void {
  const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/u.exec(key);
  if (!match) assignmentInputError();
  const parts = [
    match[1] ?? '',
    ...Array.from((match[2] ?? '').matchAll(/\[([^[\]]*)\]/gu), (part) => part[1] ?? ''),
  ];
  let target = payload;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    if (!part || ['__proto__', 'constructor', 'prototype'].includes(part)) assignmentInputError();
    if (index === parts.length - 1) {
      if (Object.hasOwn(target, part)) assignmentInputError();
      target[part] = value;
    } else if (index === parts.length - 2 && parts[index + 1] === '') {
      if (Object.hasOwn(target, part) && !Array.isArray(target[part])) assignmentInputError();
      target[part] ??= [];
      if (value !== undefined) (target[part] as unknown[]).push(value);
      return;
    } else {
      target[part] ??= {};
      target = object(target[part]);
    }
  }
}

export interface AssignmentRequest {
  request: GitHubToolInput;
  effects: AssignmentEffect[];
}

/** snapshot external API inputs before inspecting and executing the same bytes. */
export default async function inspectAssignmentRequest(
  input: GitHubToolInput,
  cwd: string,
  read = readInput,
): Promise<AssignmentRequest> {
  const unchanged = {
    request: { ...input, argv: [...input.argv] },
    effects: cliAssignmentRemovals(input),
  };
  const { command, position } = resolveGitHubCommand(input.argv);
  if (command !== 'api') return unchanged;
  const offset = position + 1;
  const parsed = argumentsFor(input.argv.slice(offset), apiValueOptions);
  if (parsed.help) return unchanged;
  const endpoint = parsed.positional[0] ?? '';
  let path: string;
  try {
    path = new URL(endpoint).pathname;
  } catch {
    path = `/${endpoint.replace(/^\//u, '').split(/[?#]/u)[0]}`;
  }
  try {
    path = decodeURIComponent(path).replace(/\/+$/u, '');
  } catch {
    return unchanged;
  }
  const method =
    parsed.options
      .filter((option) => ['--method', '-X'].includes(option.name))
      .at(-1)
      ?.value.toUpperCase() ??
    (parsed.options.some((option) =>
      ['--field', '--raw-field', '-F', '-f', '--input'].includes(option.name),
    )
      ? 'POST'
      : 'GET');
  const graphql = path.toLowerCase() === '/graphql';
  const rest = /^\/repos\/[^/]+\/[^/]+\/issues\/\d+(\/assignees)?$/iu.test(path);
  if (!graphql && (!rest || !['DELETE', 'PATCH'].includes(method))) return unchanged;
  if (
    !graphql &&
    ((/\/assignees$/iu.test(path) && method !== 'DELETE') ||
      (!/\/assignees$/iu.test(path) && method !== 'PATCH'))
  )
    return unchanged;
  if (!graphql && (method === 'GET' || method === 'HEAD')) return unchanged;
  // URL query parameters and body fields must not disagree about the protected effect.
  if (/[?#]/u.test(endpoint)) assignmentInputError();
  const inputOptions = parsed.options.filter((option) => option.name === '--input');
  if (inputOptions.length > 1) assignmentInputError();
  const fieldOptions = parsed.options.filter((option) =>
    ['--field', '--raw-field', '-F', '-f'].includes(option.name),
  );
  if (inputOptions.length && fieldOptions.length) assignmentInputError();
  const argv = [...input.argv];
  let stdin = input.stdin;
  let payload: Record<string, unknown> = {};
  if (inputOptions[0]) {
    const option = inputOptions[0];
    stdin = await read(option.value, cwd, input.stdin);
    try {
      payload = object(JSON.parse(stdin));
    } catch {
      assignmentInputError();
    }
    argv.splice(offset + option.index, option.count, '--input', '-');
  } else {
    // replace file-backed typed fields with immutable raw fields while preserving gh's field semantics.
    for (const option of [...fieldOptions].reverse()) {
      const equal = option.value.indexOf('=');
      const key = equal < 0 ? option.value : option.value.slice(0, equal);
      let raw = equal < 0 ? undefined : option.value.slice(equal + 1);
      const typed = option.name === '-F' || option.name === '--field';
      if (typed && raw?.startsWith('@')) {
        raw = await read(raw.slice(1), cwd, input.stdin);
        argv.splice(
          offset + option.index,
          option.count,
          ...(option.prefix ? [option.prefix] : []),
          '--raw-field',
          `${key}=${raw}`,
        );
      }
    }
    // parse snapshotted fields in order; reject conflicting scalar/array representations.
    const fields = argumentsFor(argv.slice(offset), apiValueOptions).options.filter((option) =>
      ['--field', '--raw-field', '-F', '-f'].includes(option.name),
    );
    for (const option of fields) {
      const equal = option.value.indexOf('=');
      const key = equal < 0 ? option.value : option.value.slice(0, equal);
      const raw = equal < 0 ? undefined : option.value.slice(equal + 1);
      const typed = option.name === '-F' || option.name === '--field';
      const value: unknown =
        typed && raw === 'null'
          ? null
          : typed && raw === 'true'
            ? true
            : typed && raw === 'false'
              ? false
              : raw;
      setField(payload, key, value);
    }
    if (graphql) {
      const { query, operationName, ...variables } = payload;
      payload = { query, ...(operationName === undefined ? {} : { operationName }), variables };
    }
  }
  const request = { argv, ...(stdin === undefined ? {} : { stdin }) };
  if (graphql) return { request, effects: graphqlAssignmentEffects(payload) };
  if (!Object.hasOwn(payload, 'assignees') && !Object.hasOwn(payload, 'assignee'))
    return { request, effects: [] };
  if (Object.hasOwn(payload, 'assignees') && Object.hasOwn(payload, 'assignee'))
    assignmentInputError();
  const effect: AssignmentEffect = {
    mode: method === 'DELETE' ? 'remove' : 'replace',
    identity: 'login',
    members: members(Object.hasOwn(payload, 'assignees') ? payload.assignees : payload.assignee),
    target: { rest: path.replace(/\/assignees$/iu, '') },
  };
  if (effect.members.some((member) => /\{(?:owner|repo|branch)\}/u.test(member)))
    assignmentInputError();
  return { request, effects: [effect] };
}
