import type {
  AgentSystemAuthorizationDecision,
  AgentSystemOperation,
  AgentSystemRisk,
} from '../../lib/tool-types.ts';
import type { GitHubManifestConfiguration } from '../../utils/github-section-schema.ts';
import { resolveGitHubPolicyConfiguration } from './config-schema.ts';
import type { GitHubToolInput } from './tool-schema.ts';

const releasesPolicyAttribute = 'github.policy.releases';
const globalOptionsWithValues = new Set(['--hostname', '--repo', '-R']);
const apiOptionsWithValues = new Set([
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
const readWords = new Set([
  'check',
  'checks',
  'diff',
  'download',
  'get',
  'list',
  'logs',
  'show',
  'status',
  'verify',
  'view',
  'watch',
]);
const destructiveWords = new Set(['archive', 'cancel', 'delete', 'destroy', 'purge', 'remove']);
const destructiveFlags = new Set(['--cleanup-tag', '--delete-branch', '--delete-last']);
const rootReadCommands = new Set(['completion', 'help', 'search', 'status', 'version']);
const releaseReadSubcommands = new Set(['download', 'list', 'ls', 'view']);

export function githubCommandPosition(argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? '';
    if (value === '--') return index + 1;
    if (globalOptionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('-')) return index;
  }
  return -1;
}

function operation(
  risk: AgentSystemRisk,
  command: string,
  subcommand?: string,
  releases = false,
): AgentSystemOperation {
  return {
    action: 'github.cli.invoke',
    ...(releases ? { attributes: { [releasesPolicyAttribute]: true } } : {}),
    risk,
    summary: `Run gh ${command}${subcommand ? ` ${subcommand}` : ''}`,
    resources: [{ type: 'host', id: 'github.com' }],
  };
}

function words(value: string | undefined): string[] {
  return value?.toLowerCase().split('-').filter(Boolean) ?? [];
}

function includesWord(values: readonly (string | undefined)[], expected: Set<string>): boolean {
  return values.some(
    (value) =>
      Boolean(value && expected.has(value.toLowerCase())) ||
      words(value).some((word) => expected.has(word)),
  );
}

function apiArgumentValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? '';
    if (value === name && argv[index + 1] !== undefined) values.push(argv[index + 1] ?? '');
    if (value.startsWith(`${name}=`)) values.push(value.slice(name.length + 1));
    if (name.length === 2 && value.startsWith(name) && value.length > name.length) {
      values.push(value.slice(name.length));
    }
  }
  return values;
}

function apiArgumentValue(argv: readonly string[], name: string): string | undefined {
  return apiArgumentValues(argv, name)[0];
}

function hasApiArgument(argv: readonly string[], name: string): boolean {
  return apiArgumentValues(argv, name).length > 0;
}

function apiEndpoint(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? '';
    if (value === '--') return argv[index + 1];
    const optionName = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
    if (apiOptionsWithValues.has(optionName)) {
      if (value === optionName) index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    return value;
  }
  return undefined;
}

function apiMethod(argv: readonly string[]): string {
  return (
    apiArgumentValue(argv, '--method') ??
    apiArgumentValue(argv, '-X') ??
    (['--field', '--input', '--raw-field', '-F', '-f'].some((name) => hasApiArgument(argv, name))
      ? 'POST'
      : 'GET')
  ).toUpperCase();
}

function apiPath(endpoint: string): string {
  try {
    return new URL(endpoint).pathname.replace(/\/+$/u, '');
  } catch {
    return `/${(endpoint.split(/[?#]/u, 1)[0] ?? '').replace(/^\/+|\/+$/gu, '')}`;
  }
}

function isReleaseApiMutation(endpoint: string, method: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  const path = apiPath(endpoint);
  if (/^\/repos\/[^/]+\/[^/]+\/releases\/generate-notes$/iu.test(path)) return false;
  return /^\/repos\/[^/]+\/[^/]+\/releases(?:\/|$)/iu.test(path);
}

function classifyApi(argv: readonly string[]): AgentSystemOperation {
  const endpoint = apiEndpoint(argv);
  const method = apiMethod(argv);
  const risk: AgentSystemRisk =
    method === 'GET' || method === 'HEAD' ? 'read' : method === 'DELETE' ? 'destructive' : 'write';
  return operation(
    endpoint ? risk : 'unknown',
    'api',
    undefined,
    argv.some((value) => isReleaseApiMutation(value, method)),
  );
}

/** Classify a GitHub CLI request and select only explicit release mutations for policy. */
export function classifyGitHubOperation(input: GitHubToolInput): AgentSystemOperation {
  const position = githubCommandPosition(input.argv);
  const command = position < 0 ? 'command' : (input.argv[position]?.toLowerCase() ?? 'command');
  const subcommandOffset =
    position < 0 ? -1 : githubCommandPosition(input.argv.slice(position + 1));
  const subcommandPosition =
    position < 0 || subcommandOffset < 0 ? -1 : position + 1 + subcommandOffset;
  const subcommand =
    subcommandPosition < 0 ? undefined : input.argv[subcommandPosition]?.toLowerCase();
  const nestedCommand =
    subcommandPosition < 0 ? undefined : input.argv[subcommandPosition + 1]?.toLowerCase();

  if (command === 'api') return classifyApi(input.argv.slice(position + 1));
  if (command === 'release') {
    if (
      !subcommand ||
      subcommand === '--help' ||
      subcommand === '-h' ||
      releaseReadSubcommands.has(subcommand) ||
      nestedCommand === '--help' ||
      nestedCommand === '-h'
    ) {
      return operation('read', command, subcommand);
    }
    const risk = includesWord([subcommand], destructiveWords) ? 'destructive' : 'write';
    return operation(risk, command, subcommand, true);
  }
  if (input.argv.some((value) => value === '--help' || value === '-h')) {
    return operation('read', command, subcommand);
  }
  if (
    includesWord([subcommand, nestedCommand], destructiveWords) ||
    input.argv.some((value) => destructiveFlags.has(value.split('=')[0] ?? value))
  ) {
    return operation('destructive', command, subcommand);
  }
  if (rootReadCommands.has(command) || includesWord([subcommand, nestedCommand], readWords)) {
    return operation('read', command, subcommand);
  }
  return operation(position < 0 ? 'unknown' : 'write', command, subcommand);
}

/** Apply the manifest's releases policy without authorizing through risk metadata. */
export function authorizeGitHubOperation(
  operation: AgentSystemOperation,
  configuration: GitHubManifestConfiguration,
): AgentSystemAuthorizationDecision {
  if (operation.attributes?.[releasesPolicyAttribute] !== true) return { status: 'allowed' };
  if (resolveGitHubPolicyConfiguration(configuration).releases === 'allow') {
    return { status: 'allowed' };
  }
  return {
    status: 'denied',
    reason:
      'GitHub release mutations are denied by github.policy.releases. To permit this operation, an operator must set github.policy.releases to allow in agent.yaml and retry.',
  };
}
