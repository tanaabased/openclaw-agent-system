import type { AgentSystemOperation, AgentSystemRisk } from '../../lib/tool-types.ts';
import type { GitPolicyConfiguration } from './config-schema.ts';
import type { GitToolInput } from './tool-schema.ts';

export type GitProtectedOperation = keyof GitPolicyConfiguration;

const protectionOrder: readonly GitProtectedOperation[] = ['forcePush', 'deleteRemoteRef'];
const protectionFields: Record<GitProtectedOperation, string> = {
  deleteRemoteRef: 'delete-remote-ref',
  forcePush: 'force-push',
};
const readCommands = new Set([
  'annotate',
  'archive',
  'blame',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-mailmap',
  'check-ref-format',
  'cherry',
  'count-objects',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'difftool',
  'fast-export',
  'for-each-ref',
  'fsck',
  'grep',
  'help',
  'interpret-trailers',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'merge-tree',
  'name-rev',
  'patch-id',
  'range-diff',
  'request-pull',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-branch',
  'show-ref',
  'status',
  'var',
  'verify-commit',
  'verify-tag',
  'version',
  'whatchanged',
]);
const writeCommands = new Set([
  'add',
  'am',
  'apply',
  'backfill',
  'bugreport',
  'cherry-pick',
  'clone',
  'commit',
  'diagnose',
  'fast-import',
  'fetch',
  'filter-branch',
  'format-patch',
  'gc',
  'init',
  'maintenance',
  'merge',
  'mergetool',
  'mv',
  'pack-refs',
  'prune',
  'pull',
  'push',
  'rebase',
  'repack',
  'revert',
  'rm',
  'stage',
  'submodule',
]);

export function gitCommandPosition(argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? '';
    if (value === '--') return index + 1;
    if (!value.startsWith('-')) return index;
  }
  return -1;
}

/** Keep raw worktree mutation closed until the semantic worktree service owns its operands. */
export function isRawGitWorktreeMutation(argv: readonly string[]): boolean {
  if (argv.some((value) => value === '--help' || value === '-h' || value === '--version')) {
    return false;
  }
  const position = gitCommandPosition(argv);
  if (position < 0 || argv[position]?.toLowerCase() !== 'worktree') return false;
  return argv[position + 1]?.toLowerCase() !== 'list';
}

function hasFlag(argv: readonly string[], flags: readonly string[]): boolean {
  return argv.some((argument) =>
    flags.some(
      (flag) =>
        argument === flag ||
        argument.startsWith(`${flag}=`) ||
        (flag.length === 2 && argument.startsWith(flag) && argument.length > 2),
    ),
  );
}

function hasProtectedLongOption(argv: readonly string[], options: readonly string[]): boolean {
  return argv.some((argument) => {
    if (!argument.startsWith('--')) return false;
    const option = argument.split('=', 1)[0] ?? '';
    return option.length > 2 && options.some((candidate) => candidate.startsWith(option));
  });
}

function hasProtectedShortOption(argv: readonly string[], option: string): boolean {
  return argv.some((argument) => {
    if (!argument.startsWith('-') || argument.startsWith('--')) return false;
    for (const candidate of argument.slice(1)) {
      if (candidate === 'o') return false;
      if (candidate === option) return true;
    }
    return false;
  });
}

function operation(
  risk: AgentSystemRisk,
  command: string,
  protections: readonly GitProtectedOperation[] = [],
  attributes: Record<string, string | number | boolean> = {},
): AgentSystemOperation {
  const selectedProtections = protectionOrder.filter((protection) =>
    protections.includes(protection),
  );
  const operationAttributes = {
    ...Object.fromEntries(
      selectedProtections.map((protection) => [`git.policy.${protectionFields[protection]}`, true]),
    ),
    ...attributes,
  };
  return {
    action: 'git.cli.invoke',
    ...(Object.keys(operationAttributes).length === 0 ? {} : { attributes: operationAttributes }),
    risk,
    summary: `Run git ${command}`,
    resources: [{ type: 'workspace', id: 'active-agent' }],
  };
}

function protectedOperation(
  command: string,
  protections: readonly GitProtectedOperation[],
): AgentSystemOperation {
  return operation('destructive', command, protections);
}

export function gitOperationProtections(operation: AgentSystemOperation): GitProtectedOperation[] {
  return protectionOrder.filter(
    (protection) => operation.attributes?.[`git.policy.${protectionFields[protection]}`] === true,
  );
}

function classifyPush(argv: readonly string[], command: string): AgentSystemOperation {
  const protections: GitProtectedOperation[] = [];
  const mirrors = hasProtectedLongOption(argv, ['--mirror']);
  if (
    mirrors ||
    argv.some((argument) => argument.startsWith('+') && argument.length > 1) ||
    hasProtectedLongOption(argv, ['--force', '--force-with-lease']) ||
    hasProtectedShortOption(argv, 'f')
  ) {
    protections.push('forcePush');
  }
  if (
    mirrors ||
    argv.some((argument) => {
      const refspec = argument.startsWith('+') ? argument.slice(1) : argument;
      return refspec.startsWith(':') && refspec.length > 1;
    }) ||
    hasProtectedLongOption(argv, ['--delete', '--prune']) ||
    hasProtectedShortOption(argv, 'd')
  ) {
    protections.push('deleteRemoteRef');
  }
  return protections.length === 0
    ? operation('write', command)
    : protectedOperation(command, protections);
}

function classifyBranch(argv: readonly string[], command: string): AgentSystemOperation {
  return argv.length === 0 || hasFlag(argv, ['--list', '--show-current', '-l'])
    ? operation('read', command)
    : operation('write', command);
}

function classifyTag(argv: readonly string[], command: string): AgentSystemOperation {
  return argv.length === 0 || hasFlag(argv, ['--list', '-l'])
    ? operation('read', command)
    : operation('write', command);
}

function classifySubcommand(
  argv: readonly string[],
  command: string,
  readSubcommands: readonly string[],
): AgentSystemOperation {
  const subcommand = argv[0]?.toLowerCase();
  return readSubcommands.includes(subcommand ?? '')
    ? operation('read', command)
    : operation('write', command);
}

/** Classify stable Git commands and select only explicit protected remote effects. */
export function classifyGitOperation(input: GitToolInput): AgentSystemOperation {
  const position = gitCommandPosition(input.argv);
  const command = position < 0 ? 'command' : (input.argv[position]?.toLowerCase() ?? 'command');
  const argv = position < 0 ? input.argv : input.argv.slice(position + 1);

  if (input.argv.some((value) => value === '--help' || value === '-h' || value === '--version')) {
    return operation('read', command);
  }
  if (command === 'config' || command === 'remote') return operation('read', command);
  if (command === 'branch') return classifyBranch(argv, command);
  if (command === 'tag') return classifyTag(argv, command);
  if (command === 'bisect') return classifySubcommand(argv, command, ['log', 'visualize', 'view']);
  if (command === 'bundle') return classifySubcommand(argv, command, ['list-heads', 'verify']);
  if (command === 'notes') return classifySubcommand(argv, command, ['get-ref', 'list', 'show']);
  if (command === 'rerere')
    return classifySubcommand(argv, command, ['diff', 'remaining', 'status']);
  if (command === 'sparse-checkout') return classifySubcommand(argv, command, ['list']);
  if (command === 'clean') {
    return hasFlag(argv, ['--dry-run', '-n'])
      ? operation('read', command)
      : operation('write', command);
  }
  if (command === 'reflog') {
    return ['delete', 'drop', 'expire'].includes(argv[0]?.toLowerCase() ?? '') &&
      !hasFlag(argv, ['--dry-run', '-n'])
      ? operation('write', command)
      : operation('read', command);
  }
  if (command === 'stash') {
    const subcommand = argv[0]?.toLowerCase();
    return !subcommand || subcommand === 'list' || subcommand === 'show'
      ? operation('read', command)
      : operation('write', command);
  }
  if (command === 'replace') {
    return argv.length === 0 || hasFlag(argv, ['--list', '-l'])
      ? operation('read', command)
      : operation('write', command);
  }
  if (command === 'rebase' && hasFlag(argv, ['--show-current-patch'])) {
    return operation('read', command);
  }
  if (
    command === 'restore' ||
    command === 'checkout' ||
    command === 'switch' ||
    command === 'reset'
  ) {
    return operation('write', command);
  }
  if (command === 'worktree') {
    return isRawGitWorktreeMutation(input.argv)
      ? operation('unknown', command)
      : operation('read', command);
  }
  if (command === 'push') return classifyPush(argv, command);
  if (readCommands.has(command)) return operation('read', command);
  if (writeCommands.has(command)) return operation('write', command);
  return operation('unknown', command, [], { 'git.extension': command });
}
