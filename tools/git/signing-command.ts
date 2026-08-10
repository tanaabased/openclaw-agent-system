import { gitCommandPosition } from './policy.ts';
import type { GitToolInput } from './tool-schema.ts';

const commitProducingCommands = new Set([
  'am',
  'cherry-pick',
  'commit',
  'merge',
  'pull',
  'rebase',
  'revert',
]);

function commandAndArguments(input: GitToolInput): {
  argv: readonly string[];
  command?: string;
} {
  const position = gitCommandPosition(input.argv);
  return position < 0
    ? { argv: input.argv }
    : {
        argv: input.argv.slice(position + 1),
        command: input.argv[position]?.toLowerCase(),
      };
}

function hasOption(argv: readonly string[], options: readonly string[]): boolean {
  return argv.some((argument) =>
    options.some(
      (option) =>
        argument === option ||
        argument.startsWith(`${option}=`) ||
        (option.length === 2 && argument.startsWith(option) && argument.length > 2),
    ),
  );
}

function tagCreatesSignedObject(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  return !hasOption(argv, [
    '--column',
    '--contains',
    '--delete',
    '--format',
    '--list',
    '--merged',
    '--no-column',
    '--no-contains',
    '--no-merged',
    '--points-at',
    '--sort',
    '--verify',
    '-d',
    '-l',
    '-n',
    '-v',
  ]);
}

/** Select operations that may ask Git to create a managed signed object. */
export function gitCommandUsesSigningResources(input: GitToolInput): boolean {
  if (input.argv.some((value) => ['--help', '--version', '-h'].includes(value))) return false;
  const { argv, command } = commandAndArguments(input);
  if (!command) return false;
  if (command === 'tag') return tagCreatesSignedObject(argv);
  if (!commitProducingCommands.has(command)) return false;
  if (command === 'commit') {
    return !hasOption(argv, ['--branch', '--dry-run', '--porcelain', '--short', '--status']);
  }
  if (['cherry-pick', 'revert'].includes(command)) {
    return !hasOption(argv, ['--abort', '--no-commit', '--quit', '-n']);
  }
  if (command === 'merge') {
    return !hasOption(argv, ['--abort', '--ff-only', '--no-commit', '--quit', '--squash']);
  }
  if (command === 'pull') {
    return !hasOption(argv, ['--ff-only', '--no-commit', '--squash']);
  }
  if (command === 'rebase') {
    return !hasOption(argv, ['--abort', '--edit-todo', '--quit', '--show-current-patch']);
  }
  return !hasOption(argv, ['--abort', '--quit', '--show-current-patch']);
}

/** Detect command-owned signing controls that would override managed signing. */
export function gitCommandHasSigningControl(input: GitToolInput): boolean {
  const { argv, command } = commandAndArguments(input);
  if (!command) return false;
  if (command === 'tag') {
    return hasOption(argv, ['--local-user', '--no-sign', '--sign', '-s', '-u']);
  }
  return (
    commitProducingCommands.has(command) && hasOption(argv, ['--gpg-sign', '--no-gpg-sign', '-S'])
  );
}
