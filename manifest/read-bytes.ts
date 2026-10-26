import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const maximumManifestBytes = 1024 * 1024;

/** Read regular-file bytes with a fixed cap; callers own path resolution and diagnostics. */
export default async function readBoundedManifestBytes(
  path: string,
): Promise<
  { status: 'valid'; contents: Buffer } | { status: 'not-regular' } | { status: 'too-large' }
> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile()) return { status: 'not-regular' };
    if (stats.size > maximumManifestBytes) return { status: 'too-large' };
    // Keep the read bounded even if the file grows after inspection.
    const buffer = Buffer.alloc(maximumManifestBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximumManifestBytes) return { status: 'too-large' };
    return { status: 'valid', contents: buffer.subarray(0, size) };
  } finally {
    await file.close();
  }
}
