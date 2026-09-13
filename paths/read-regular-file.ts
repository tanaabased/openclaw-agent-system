import { lstat, readFile } from 'node:fs/promises';

import nodeErrorCode from '../utils/node-error-code.ts';

/** Read a regular text file, returning undefined when it does not exist. */
export default async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`${path} must be a regular file and may not be a symbolic link.`);
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}
