import type {
  AgentSystemAuthorizationDecision,
  AgentSystemOperation,
  AgentSystemRisk,
} from '../../lib/tool-types.ts';
import {
  resolveGitPolicyConfiguration,
  type GitPolicyConfiguration,
  type GitToolConfiguration,
} from './config-schema.ts';
import type { GitToolInput } from './tool-schema.ts';

export type GitPolicyHazard = Exclude<keyof GitPolicyConfiguration, 'unknown'>;

const hazardOrder: readonly GitPolicyHazard[] = ['force', 'rewrite', 'discard', 'delete'];
const readCommands = new Set([
  'annotate',
  'blame',
  'cat-file',
  'count-objects',
  'describe',
  'diff',
  'diff-tree',
  'for-each-ref',
  'fsck',
  'grep',
  'help',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'name-rev',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'version',
  'whatchanged',
]);
const writeCommands = new Set([
  'add',
  'am',
  'apply',
  'cherry-pick',
  'clone',
  'commit',
  'fetch',
  'format-patch',
  'init',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'repack',
  'revert',
  'rm',
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

function uniqueHazards(hazards: readonly GitPolicyHazard[]): GitPolicyHazard[] {
  return hazardOrder.filter((hazard) => hazards.includes(hazard));
}

function operation(
  risk: AgentSystemRisk,
  command: string,
  hazards: readonly GitPolicyHazard[] = [],
): AgentSystemOperation {
  const selectedHazards = uniqueHazards(hazards);
  return {
    action: 'git.cli.invoke',
    ...(selectedHazards.length === 0
      ? {}
      : {
          attributes: Object.fromEntries(
            selectedHazards.map((hazard) => [`git.policy.${hazard}`, true]),
          ),
        }),
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
  if (command === 'fetch' || command === 'pull') return classifyFetch(argv, command);
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
    const subcommand = argv[0]?.toLowerCase();
    if (subcommand === 'remove') {
      return hasFlag(argv, ['--force', '-f'])
        ? hazardous(command, ['force', 'discard', 'delete'])
        : hazardous(command, ['delete']);
    }
    if (subcommand === 'prune') {
      return hasFlag(argv, ['--dry-run', '-n'])
        ? operation('read', command)
        : hazardous(command, ['delete']);
    }
    if (subcommand === 'add' && hasFlag(argv, ['-B'])) {
      return hazardous(command, ['force', 'rewrite']);
    }
    return operation(subcommand === 'list' ? 'read' : 'write', command);
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
  if (command === 'filter-branch') return hazardous(command, ['rewrite']);
  if (command === 'gc' || command === 'prune') return hazardous(command, ['delete']);
  if (readCommands.has(command)) return operation('read', command);
  if (writeCommands.has(command)) return operation('write', command);
  return operation('unknown', command);
}

function policyReferences(hazards: readonly (GitPolicyHazard | 'unknown')[]): string {
  return hazards.map((hazard) => `git.policy.${hazard}`).join(' and ');
}

function hazardLabel(hazards: readonly (GitPolicyHazard | 'unknown')[]): string {
  return hazards.join(' and ');
}

/** Apply the manifest's Git-specific hazard policy after classification. */
export function authorizeGitOperation(
  operation: AgentSystemOperation,
  configuration: GitToolConfiguration,
): AgentSystemAuthorizationDecision {
  if (operation.risk === 'read' || operation.risk === 'write') return { status: 'allowed' };
  const policy = resolveGitPolicyConfiguration(configuration.git);
  const hazards: Array<GitPolicyHazard | 'unknown'> =
    operation.risk === 'destructive' ? gitOperationHazards(operation) : ['unknown'];
  if (hazards.length === 0) hazards.push('unknown');
  const denied = hazards.filter((hazard) => policy[hazard] === 'deny');
  if (denied.length > 0) {
    return {
      status: 'denied',
      reason: `Git ${hazardLabel(denied)} operations are denied by ${policyReferences(denied)}.`,
    };
  }
  const approvals = hazards.filter((hazard) => policy[hazard] === 'ask');
  if (approvals.length > 0) {
    return {
      status: 'approval_required',
      reason: `Git ${hazardLabel(approvals)} operations require approval in an OpenClaw agent conversation; direct tool commands cannot request approval.`,
      request: {
        description: `Allow the active agent to ${operation.summary.toLowerCase()}?`,
        severity: approvals.includes('unknown') ? 'warning' : 'critical',
        title: `Approve ${hazardLabel(approvals)} Git operation`,
      },
    };
  }
  return { status: 'allowed' };
}
