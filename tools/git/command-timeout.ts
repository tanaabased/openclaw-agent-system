import { managedCommandTimeoutMs, metadataCommandTimeoutMs } from '../../api/cli-budget.ts';
import { gitCommandPosition } from './operation-classifier.ts';

/** bound metadata separately from repository work and network transfers, independent of authorization. */
export default function gitCommandTimeout(argv: readonly string[]): number {
  const command = argv[0] === '--version' ? 'version' : argv[gitCommandPosition(argv)];
  if (
    [
      'rev-parse',
      'symbolic-ref',
      'show-ref',
      'check-ref-format',
      'var',
      'version',
      '--version',
    ].includes(command ?? '')
  )
    return metadataCommandTimeoutMs;
  if (
    ['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule', 'gc', 'repack', 'fsck'].includes(
      command ?? '',
    )
  )
    return managedCommandTimeoutMs;
  return 120_000;
}
