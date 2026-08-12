import type {
  AgentSystemAuthorizationDecision,
  AgentSystemOperation,
  AgentSystemRisk,
} from '../../lib/tool-types.ts';
import type { GitHubManifestConfiguration } from '../../utils/github-section-schema.ts';
import { resolveGitHubPolicyConfiguration } from './config-schema.ts';
import type { GitHubToolInput } from './tool-schema.ts';

const globalOptionsWithValues = new Set(['--hostname', '--repo', '-R']);
const apiOptionsWithValues = new Set([
  '--cache',
  '--field',
  '--header',
  '--hostname',
  '--input',
  '--jq',
  '--method',
  '--raw-field',
  '--template',
  '-F',
  '-H',
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
  'trusted-root',
  'verify',
  'view',
  'watch',
]);
const writeWords = new Set([
  'add',
  'checkout',
  'clone',
  'close',
  'comment',
  'copy',
  'create',
  'develop',
  'edit',
  'fork',
  'lock',
  'merge',
  'pin',
  'ready',
  'reopen',
  'rerun',
  'review',
  'run',
  'set',
  'sync',
  'unlock',
  'unpin',
  'update',
  'upload',
]);
const destructiveWords = new Set(['archive', 'cancel', 'delete', 'destroy', 'purge', 'remove']);
const destructiveFlags = new Set(['--cleanup-tag', '--delete-branch', '--delete-last']);
const rootReadCommands = new Set(['completion', 'help', 'search', 'status', 'version']);
const adminApiRoute =
  /\/(?:actions\/permissions|collaborators|deployments?|environments?|hooks?|installations?|keys|memberships?|members|outside_collaborators|rulesets?|secrets|teams|variables)(?:\/|$)|\/branches\/[^/]+\/protection(?:\/|$)/i;

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
): AgentSystemOperation {
  return {
    action: 'github.cli.invoke',
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

function graphqlDocument(input: GitHubToolInput, argv: readonly string[]): string | undefined {
  for (const option of ['--field', '--raw-field', '-F', '-f']) {
    const value = apiArgumentValues(argv, option).find((candidate) =>
      candidate.startsWith('query='),
    );
    if (value) return value.slice('query='.length);
  }
  if (!input.stdin) return undefined;
  try {
    const parsed = JSON.parse(input.stdin) as { query?: unknown };
    return typeof parsed.query === 'string' ? parsed.query : undefined;
  } catch {
    return undefined;
  }
}

function classifyApi(input: GitHubToolInput, argv: readonly string[]): AgentSystemRisk {
  const endpoint = apiEndpoint(argv);
  if (!endpoint) return 'unknown';

  if (endpoint === 'graphql') {
    const document = graphqlDocument(input, argv)?.trim();
    if (!document) return 'unknown';
    if (/^(?:query|subscription)\b|^\{/i.test(document)) return 'read';
    if (!/^mutation\b/i.test(document)) return 'unknown';
    if (/\b(?:archive|cancel|delete|destroy|purge|remove)[A-Z_a-z0-9]*\b/i.test(document)) {
      return 'destructive';
    }
    if (
      /\b(?:collaborator|environment|hook|key|member|permission|ruleset|secret|team|variable)[A-Z_a-z0-9]*\b/i.test(
        document,
      )
    ) {
      return 'admin';
    }
    return 'unknown';
  }

  const method = (
    apiArgumentValue(argv, '--method') ??
    apiArgumentValue(argv, '-X') ??
    (['--field', '--input', '--raw-field', '-F', '-f'].some((name) => hasApiArgument(argv, name))
      ? 'POST'
      : 'GET')
  ).toUpperCase();
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'DELETE') return 'destructive';
  if (adminApiRoute.test(`/${endpoint.replace(/^\/+/, '')}`)) return 'admin';
  return 'unknown';
}

function isAdminCommand(
  command: string,
  subcommand: string | undefined,
  nestedCommand: string | undefined,
  argv: readonly string[],
): boolean {
  if (argv.includes('--admin')) return true;
  if (command === 'repo' && ['edit', 'rename', 'transfer'].includes(subcommand ?? '')) return true;
  if (command === 'repo' && subcommand === 'deploy-key' && nestedCommand === 'add') return true;
  if (command === 'workflow' && ['disable', 'enable'].includes(subcommand ?? '')) return true;
  if (['gpg-key', 'secret', 'ssh-key', 'variable'].includes(command)) {
    return !includesWord([subcommand], readWords);
  }
  return false;
}

/** Classify a GitHub CLI request without resolving credentials or enumerating every gh command. */
export function classifyGitHubOperation(input: GitHubToolInput): AgentSystemOperation {
  const position = githubCommandPosition(input.argv);
  const command = position < 0 ? 'command' : (input.argv[position]?.toLowerCase() ?? 'command');
  const subcommand = position < 0 ? undefined : input.argv[position + 1]?.toLowerCase();
  const nestedCommand = position < 0 ? undefined : input.argv[position + 2]?.toLowerCase();

  if (input.argv.some((value) => value === '--help' || value === '-h')) {
    return operation('read', command, subcommand);
  }
  if (command === 'api')
    return operation(classifyApi(input, input.argv.slice(position + 1)), command);
  if (
    includesWord([subcommand, nestedCommand], destructiveWords) ||
    input.argv.some((value) => destructiveFlags.has(value.split('=')[0] ?? value))
  ) {
    return operation('destructive', command, subcommand);
  }
  if (isAdminCommand(command, subcommand, nestedCommand, input.argv)) {
    return operation('admin', command, subcommand);
  }
  if (rootReadCommands.has(command) || includesWord([subcommand, nestedCommand], readWords)) {
    return operation('read', command, subcommand);
  }
  if (includesWord([subcommand, nestedCommand], writeWords)) {
    return operation('write', command, subcommand);
  }
  return operation('unknown', command, subcommand);
}

/** Apply the manifest's narrow GitHub hazard policy after classification. */
export function authorizeGitHubOperation(
  operation: AgentSystemOperation,
  configuration: GitHubManifestConfiguration,
): AgentSystemAuthorizationDecision {
  if (operation.risk === 'read' || operation.risk === 'write') return { status: 'allowed' };
  const policy = resolveGitHubPolicyConfiguration(configuration);
  if (policy[operation.risk] === 'allow') return { status: 'allowed' };
  const reference = `github.policy.${operation.risk}`;
  return {
    status: 'denied',
    reason: `GitHub ${operation.risk} operations are denied by ${reference}. To permit this operation, an operator must set ${reference} to allow in agent.yaml and retry.`,
  };
}
