import isFilesystemAccessError from '../utils/is-filesystem-access-error.ts';

/** classify native filesystem denials without interpreting provider prose or requesting approval. */
export default function codexHostAccess(error: unknown): boolean {
  return (
    isFilesystemAccessError(error) ||
    (error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'automation-thread-host-access-required')
  );
}
