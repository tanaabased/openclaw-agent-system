import { dirname } from 'node:path';

import { BackupError } from './backup-types.ts';

export const maximumBackupInventoryEntries = 100_000;

/** include structural parents without restoring excluded file contents. */
export default function backupPayloadPaths(selected: Iterable<string>): string[] {
  const files = new Set(selected);
  for (const path of [...files]) {
    let parent = dirname(path);
    while (parent !== '.') {
      files.add(parent);
      parent = dirname(parent);
    }
  }
  if (files.size > maximumBackupInventoryEntries)
    throw new BackupError(
      'backup-inventory-too-large',
      'A workspace backup supports at most 100000 entries.',
    );
  return [...files].sort();
}
