import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { bindStorage, type RuntimeStorageOptions } from './backend.ts';
import type { StorageBackend } from '../../manifest/storage-schema.ts';
import { storageArchivePaths, type BackupStorage } from '../backup/backup-types.ts';

/** Export the independently selected agent and installation stores. */
export async function captureStorageBackup(
  { sqliteInstallation }: RuntimeStorageOptions,
  agentId: string,
  stage: string,
  created: (path: string) => Promise<void>,
  backend?: StorageBackend,
): Promise<BackupStorage> {
  const db = await bindStorage(agentId, sqliteInstallation, backend);
  const paths = storageArchivePaths(agentId);
  async function capture(role: keyof BackupStorage) {
    const target = join(stage, paths[role]);
    await mkdir(dirname(target), { mode: 0o700 });
    await created(dirname(target));
    await db[role].exportSnapshot(target);
    await created(target);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(target)) {
      hash.update(chunk);
      size += chunk.length;
    }
    return { size, sha256: hash.digest('hex') };
  }
  return { agent: await capture('agent'), installation: await capture('installation') };
}
