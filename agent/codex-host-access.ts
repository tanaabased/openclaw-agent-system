/** classify native filesystem denials without interpreting provider prose or requesting approval. */
export default function codexHostAccess(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    ['EPERM', 'EACCES', 'automation-thread-host-access-required'].includes(String(error.code))
  );
}
