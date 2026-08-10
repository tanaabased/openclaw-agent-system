import type { AgentSystemOperation, AgentSystemRisk } from '../../lib/tool-types.ts';
import type { GitPolicyConfiguration } from './config-schema.ts';
import type { GitToolInput } from './tool-schema.ts';

export type GitPolicyHazard = Exclude<keyof GitPolicyConfiguration, 'unknown'>;

const hazardOrder: readonly GitPolicyHazard[] = ['force', 'rewrite', 'discard', 'delete'];
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
  'fetch',
  'format-patch',
  'init',
  'merge',
  'mergetool',
  'mv',
  'pack-refs',
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

function hasForceRefspec(argv: readonly string[]): boolean {
  return argv.some((argument) => argument.startsWith('+') && argument.length > 1);
}

function pullRebases(argv: readonly string[]): boolean {
  return argv.some((argument) => {
    if (argument === '--rebase' || argument === '-r') return true;
    if (!argument.startsWith('--rebase=')) return false;
    return argument.slice('--rebase='.length).toLowerCase() !== 'false';
  });
}

function uniqueHazards(hazards: readonly GitPolicyHazard[]): GitPolicyHazard[] {
  return hazardOrder.filter((hazard) => hazards.includes(hazard));
}

function operation(
  risk: AgentSystemRisk,
  command: string,
  hazards: readonly GitPolicyHazard[] = [],
  attributes: Record<string, string | number | boolean> = {},
): AgentSystemOperation {
  const selectedHazards = uniqueHazards(hazards);
  const operationAttributes = {
    ...Object.fromEntries(selectedHazards.map((hazard) => [`git.policy.${hazard}`, true])),
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

function hazardous(command: string, hazards: readonly GitPolicyHazard[]): AgentSystemOperation {
  return operation('destructive', command, hazards);
}

export function gitOperationHazards(operation: AgentSystemOperation): GitPolicyHazard[] {
  return hazardOrder.filter((hazard) => operation.attributes?.[`git.policy.${hazard}`] === true);
}

function classifyBranch(argv: readonly string[], command: string): AgentSystemOperation {
  if (hasFlag(argv, ['-D'])) return hazardous(command, ['force', 'delete']);
  if (hasFlag(argv, ['--delete', '-d'])) return hazardous(command, ['delete']);
  if (hasFlag(argv, ['--force', '-f', '-M', '-C'])) {
    return hazardous(command, ['force', 'rewrite']);
  }
  if (argv.length === 0 || hasFlag(argv, ['--list', '--show-current', '-l'])) {
    return operation('read', command);
  }
  return operation('write', command);
}

function classifyTag(argv: readonly string[], command: string): AgentSystemOperation {
  if (hasFlag(argv, ['--delete', '-d'])) return hazardous(command, ['delete']);
  if (hasFlag(argv, ['--force', '-f'])) return hazardous(command, ['force', 'rewrite']);
  if (argv.length === 0 || hasFlag(argv, ['--list', '-l'])) return operation('read', command);
  return operation('write', command);
}

function classifyFetch(argv: readonly string[], command: string): AgentSystemOperation {
  const hazards: GitPolicyHazard[] = [];
  if (hasForceRefspec(argv) || hasFlag(argv, ['--force', '-f'])) {
    hazards.push('force', 'rewrite');
  }
  if (hasFlag(argv, ['--prune', '--prune-tags', '-p', '-P'])) hazards.push('delete');
  return hazards.length === 0 ? operation('write', command) : hazardous(command, hazards);
}

function classifyPull(argv: readonly string[], command: string): AgentSystemOperation {
  const operation = classifyFetch(argv, command);
  if (!pullRebases(argv)) return operation;
  return hazardous(command, [...gitOperationHazards(operation), 'rewrite']);
}

function classifyPush(argv: readonly string[], command: string): AgentSystemOperation {
  const hazards: GitPolicyHazard[] = [];
  const mirrors = hasFlag(argv, ['--mirror']);
  if (mirrors || hasForceRefspec(argv) || hasFlag(argv, ['--force', '--force-with-lease', '-f'])) {
    hazards.push('force', 'rewrite');
  }
  if (
    mirrors ||
    argv.some((value) => value.startsWith(':')) ||
    hasFlag(argv, ['--delete', '--prune', '-d'])
  ) {
    hazards.push('delete');
  }
  return hazards.length === 0 ? operation('write', command) : hazardous(command, hazards);
}

function classifyReset(argv: readonly string[], command: string): AgentSystemOperation {
  if (hasFlag(argv, ['--hard', '--keep', '--merge'])) {
    return hazardous(command, ['rewrite', 'discard']);
  }
  if (
    argv.includes('--') ||
    hasFlag(argv, ['--patch', '--pathspec-from-file', '-p']) ||
    argv.length === 0
  ) {
    return operation('write', command);
  }
  return hazardous(command, ['rewrite']);
}

function classifyCheckout(argv: readonly string[], command: string): AgentSystemOperation {
  if (hasFlag(argv, ['-B'])) return hazardous(command, ['force', 'rewrite']);
  if (hasFlag(argv, ['--discard-changes', '--force', '-f'])) {
    return hazardous(command, ['force', 'discard']);
  }
  if (hasFlag(argv, ['--detach', '--orphan', '-b']) || argv.length === 0) {
    return operation('write', command);
  }
  // Checkout is ambiguous between branch switching and path restoration. Prefer
  // switch or restore so policy can classify the requested effect explicitly.
  return hazardous(command, ['discard']);
}

function classifySwitch(argv: readonly string[], command: string): AgentSystemOperation {
  if (hasFlag(argv, ['-C'])) return hazardous(command, ['force', 'rewrite']);
  if (hasFlag(argv, ['--discard-changes', '--force', '-f'])) {
    return hazardous(command, ['force', 'discard']);
  }
  return operation('write', command);
}

function classifyBisect(argv: readonly string[], command: string): AgentSystemOperation {
  const subcommand = argv[0]?.toLowerCase();
  return ['log', 'visualize', 'view'].includes(subcommand ?? '')
    ? operation('read', command)
    : operation('write', command);
}

function classifyBundle(argv: readonly string[], command: string): AgentSystemOperation {
  const subcommand = argv[0]?.toLowerCase();
  return ['list-heads', 'verify'].includes(subcommand ?? '')
    ? operation('read', command)
    : operation('write', command);
}

function classifyNotes(argv: readonly string[], command: string): AgentSystemOperation {
  let subcommand: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]?.toLowerCase();
    if (value === '--ref') {
      index += 1;
      continue;
    }
    if (value?.startsWith('--ref=')) continue;
    if (value && !value.startsWith('-')) {
      subcommand = value;
      break;
    }
  }
  if (!subcommand || ['get-ref', 'list', 'show'].includes(subcommand)) {
    return operation('read', command);
  }
  return ['prune', 'remove'].includes(subcommand)
    ? hazardous(command, ['delete'])
    : operation('write', command);
}

function classifyRerere(argv: readonly string[], command: string): AgentSystemOperation {
  const subcommand = argv[0]?.toLowerCase();
  if (['diff', 'remaining', 'status'].includes(subcommand ?? '')) {
    return operation('read', command);
  }
  return ['clear', 'forget', 'gc'].includes(subcommand ?? '')
    ? hazardous(command, ['delete'])
    : operation('write', command);
}

/** Classify stable Git command shapes before the executable can resolve git-* helpers. */
export function classifyGitOperation(input: GitToolInput): AgentSystemOperation {
  const position = gitCommandPosition(input.argv);
  const command = position < 0 ? 'command' : (input.argv[position]?.toLowerCase() ?? 'command');
  const argv = position < 0 ? input.argv : input.argv.slice(position + 1);

  if (input.argv.some((value) => value === '--help' || value === '-h' || value === '--version')) {
    return operation('read', command);
  }
  if (command === 'config') return operation('read', command);
  if (command === 'branch') return classifyBranch(argv, command);
  if (command === 'tag') return classifyTag(argv, command);
  if (command === 'bisect') return classifyBisect(argv, command);
  if (command === 'bundle') return classifyBundle(argv, command);
  if (command === 'notes') return classifyNotes(argv, command);
  if (command === 'rerere') return classifyRerere(argv, command);
  if (command === 'sparse-checkout') {
    return argv[0]?.toLowerCase() === 'list'
      ? operation('read', command)
      : operation('write', command);
  }
  if (command === 'remote') return operation('read', command);
  if (command === 'clean') {
    return hasFlag(argv, ['--dry-run', '-n'])
      ? operation('read', command)
      : hazardous(command, ['discard']);
  }
  if (command === 'reset') return classifyReset(argv, command);
  if (command === 'restore') {
    return hasFlag(argv, ['--staged']) && !hasFlag(argv, ['--worktree'])
      ? operation('write', command)
      : hazardous(command, ['discard']);
  }
  if (command === 'checkout') return classifyCheckout(argv, command);
  if (command === 'switch') return classifySwitch(argv, command);
  if (command === 'push') return classifyPush(argv, command);
  if (command === 'fetch') return classifyFetch(argv, command);
  if (command === 'pull') return classifyPull(argv, command);
  if (command === 'commit') {
    return hasFlag(argv, ['--amend'])
      ? hazardous(command, ['rewrite'])
      : operation('write', command);
  }
  if (command === 'rebase') {
    if (hasFlag(argv, ['--show-current-patch'])) return operation('read', command);
    if (hasFlag(argv, ['--abort', '--quit'])) return operation('write', command);
    return hazardous(command, ['rewrite']);
  }
  if (command === 'reflog') {
    const subcommand = argv[0]?.toLowerCase();
    if (
      ['delete', 'drop', 'expire'].includes(subcommand ?? '') &&
      !hasFlag(argv, ['--dry-run', '-n'])
    ) {
      return hazardous(command, ['delete']);
    }
    return operation('read', command);
  }
  if (command === 'stash') {
    const subcommand = argv[0]?.toLowerCase();
    if (['branch', 'clear', 'drop', 'pop'].includes(subcommand ?? '')) {
      return hazardous(command, ['delete']);
    }
    if (!subcommand || subcommand === 'list' || subcommand === 'show') {
      return operation('read', command);
    }
    return operation('write', command);
  }
  if (command === 'worktree') {
    return isRawGitWorktreeMutation(input.argv)
      ? operation('unknown', command)
      : operation('read', command);
  }
  if (command === 'replace') {
    if (argv.length === 0 || hasFlag(argv, ['--list', '-l'])) return operation('read', command);
    return hasFlag(argv, ['--delete', '-d'])
      ? hazardous(command, ['delete'])
      : hazardous(command, ['rewrite']);
  }
  if (command === 'rm') {
    return hasFlag(argv, ['--force', '-f'])
      ? hazardous(command, ['force', 'discard'])
      : operation('write', command);
  }
  if (command === 'fast-import' || command === 'filter-branch') {
    return hazardous(command, ['rewrite']);
  }
  if (command === 'gc' || command === 'maintenance' || command === 'prune') {
    return hazardous(command, ['delete']);
  }
  if (command === 'repack' && hasFlag(argv, ['--delete-redundant', '-A', '-d'])) {
    return hazardous(command, ['delete']);
  }
  if (readCommands.has(command)) return operation('read', command);
  if (writeCommands.has(command)) return operation('write', command);
  return operation('unknown', command, [], { 'git.extension': command });
}
