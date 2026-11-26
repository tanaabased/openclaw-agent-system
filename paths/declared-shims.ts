import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import writeAtomic from './write-atomic.ts';

export default async function declaredShims(
  directory: string,
  launcher: string,
  ids: readonly string[],
  repair: boolean,
) {
  let changed = false;
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!stat) {
    if (!ids.length || !repair) return ids.length > 0;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    changed = true;
  } else if (!stat.isDirectory())
    throw new Error('Declared launcher directory is not a directory.');
  const expected = new Set(ids);
  const quotedLauncher = "'" + launcher.replaceAll("'", "'\\''") + "'";
  for (const id of expected) {
    const path = join(directory, id);
    const content = '#!/bin/sh\nexec ' + quotedLauncher + ' ' + id + ' "$@"\n';
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (
      metadata?.isFile() &&
      (metadata.mode & 0o777) === 0o700 &&
      (await readFile(path, 'utf8')) === content
    )
      continue;
    changed = true;
    if (repair) await writeAtomic(path, content, 0o700);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (expected.has(entry.name) || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.name)) continue;
    changed = true;
    if (repair) await unlink(join(directory, entry.name));
  }
  return changed;
}

export function declaredShimDirectory(root: string, agentId: string) {
  return join(root, 'declared-launchers', agentId);
}
