import type {
  AgentSystemAuthorizationDecision,
  AgentSystemOperation,
  AgentSystemRisk,
} from '../../lib/tool-types.ts';
import { resolveGitPolicyConfiguration, type GitToolConfiguration } from './config-schema.ts';
import type { GitToolInput } from './tool-schema.ts';

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
  'revert',
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

function operation(risk: AgentSystemRisk, command: string): AgentSystemOperation {
  return {
    action: 'git.cli.invoke',
    risk,
    summary: `Run git ${command}`,
    resources: [{ type: 'workspace', id: 'active-agent' }],
  };
}

function classifyBranch(argv: readonly string[]): AgentSystemRisk {
  if (hasFlag(argv, ['--delete', '-d', '-D'])) return 'destructive';
  if (argv.length === 0 || hasFlag(argv, ['--list', '--show-current', '-l'])) return 'read';
  return 'write';
}

function classifyTag(argv: readonly string[]): AgentSystemRisk {
  if (hasFlag(argv, ['--delete', '-d'])) return 'destructive';
  if (argv.length === 0 || hasFlag(argv, ['--list', '-l'])) return 'read';
  return 'write';
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
  if (command === 'branch') return operation(classifyBranch(argv), command);
  if (command === 'tag') return operation(classifyTag(argv), command);
  if (command === 'remote') return operation('read', command);
  if (command === 'clean') {
    return operation(hasFlag(argv, ['--dry-run', '-n']) ? 'read' : 'destructive', command);
  }
  if (command === 'reset') {
    return operation(
      hasFlag(argv, ['--hard', '--keep', '--merge']) ? 'destructive' : 'write',
      command,
    );
  }
  if (command === 'restore') {
    return operation(
      hasFlag(argv, ['--staged']) && !hasFlag(argv, ['--worktree']) ? 'write' : 'destructive',
      command,
    );
  }
  if (command === 'checkout' || command === 'switch') {
    return operation(
      hasFlag(argv, ['--discard-changes', '--force', '-f']) ? 'destructive' : 'write',
      command,
    );
  }
  if (command === 'push') {
    const deletesRef = argv.some((value) => value.startsWith(':'));
    return operation(
      deletesRef || hasFlag(argv, ['--delete', '--force', '--force-with-lease', '-d', '-f'])
        ? 'destructive'
        : 'write',
      command,
    );
  }
  if (command === 'reflog') {
    return operation(
      ['delete', 'expire'].includes(argv[0]?.toLowerCase() ?? '') ? 'destructive' : 'read',
      command,
    );
  }
  if (command === 'stash') {
    const subcommand = argv[0]?.toLowerCase();
    if (subcommand === 'clear' || subcommand === 'drop') return operation('destructive', command);
    if (!subcommand || subcommand === 'list' || subcommand === 'show') {
      return operation('read', command);
    }
    return operation('write', command);
  }
  if (command === 'worktree') {
    const subcommand = argv[0]?.toLowerCase();
    if (subcommand === 'remove' || subcommand === 'prune') {
      return operation('destructive', command);
    }
    return operation(subcommand === 'list' ? 'read' : 'write', command);
  }
  if (['filter-branch', 'gc', 'prune', 'repack', 'rm'].includes(command)) {
    return operation('destructive', command);
  }
  if (readCommands.has(command)) return operation('read', command);
  if (writeCommands.has(command)) return operation('write', command);
  return operation('unknown', command);
}

/** Apply the manifest's narrow Git hazard policy after classification. */
export function authorizeGitOperation(
  operation: AgentSystemOperation,
  configuration: GitToolConfiguration,
): AgentSystemAuthorizationDecision {
  if (operation.risk === 'read' || operation.risk === 'write') return { status: 'allowed' };
  const policy = resolveGitPolicyConfiguration(configuration.git);
  const policyRisk = operation.risk === 'admin' ? 'unknown' : operation.risk;
  if (policy[policyRisk] === 'allow') return { status: 'allowed' };
  if (policy[policyRisk] === 'ask') {
    return {
      status: 'approval_required',
      reason: `Git ${policyRisk} operations require approval in an OpenClaw agent conversation; direct tool commands cannot request approval.`,
      request: {
        description: `Allow the active agent to ${operation.summary.toLowerCase()}?`,
        severity: policyRisk === 'unknown' ? 'warning' : 'critical',
        title: `Approve ${policyRisk} Git operation`,
      },
    };
  }
  return {
    status: 'denied',
    reason: `Git ${policyRisk} operations are denied by git.policy.${policyRisk}.`,
  };
}
