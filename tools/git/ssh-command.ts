import { gitCommandPosition } from './policy.ts';
import type { GitToolInput } from './tool-schema.ts';

const remoteCommands = new Set(['clone', 'fetch', 'ls-remote', 'pull', 'push', 'submodule']);

/** Select only Git commands that can require transport authentication. */
export default function gitCommandUsesSshResources(input: GitToolInput): boolean {
  const position = gitCommandPosition(input.argv);
  const command = position < 0 ? undefined : input.argv[position]?.toLowerCase();
  if (!command) return false;
  if (remoteCommands.has(command)) return true;
  return command === 'remote' && input.argv[position + 1]?.toLowerCase() === 'show';
}
