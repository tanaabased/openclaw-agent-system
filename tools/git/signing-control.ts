import { gitCommandPosition } from './operation-classifier.ts';
import type { GitToolInput } from './tool-schema.ts';

const commitSigningCommands = new Set([
  'am',
  'cherry-pick',
  'commit',
  'merge',
  'pull',
  'rebase',
  'revert',
]);

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

/** Detect explicit Git arguments that can bypass the manifest-owned signing policy. */
export default function gitCommandHasSigningControl(input: GitToolInput): boolean {
  const position = gitCommandPosition(input.argv);
  if (position < 0) return false;
  const command = input.argv[position]?.toLowerCase();
  const argv = input.argv.slice(position + 1);
  if (command === 'tag') {
    return hasOption(argv, ['--local-user', '--no-sign', '--sign', '-s', '-u']);
  }
  return (
    Boolean(command && commitSigningCommands.has(command)) &&
    hasOption(argv, ['--gpg-sign', '--no-gpg-sign', '-S'])
  );
}
