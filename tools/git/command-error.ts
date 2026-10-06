const operations = new Set([
  'common-directory inspection',
  'fetch',
  'branch validation',
  'base-ref validation',
  'worktree preparation',
  'worktree removal',
  'repository identity inspection',
  'origin inspection',
  'clone',
  'repository identity',
  'origin reconciliation',
  'origin reconciliation verification',
  'origin reconciliation fetch',
  'worktree inspection',
]);

function classify(stderr: string): string {
  if (/permission denied \(publickey\)/iu.test(stderr)) return 'ssh-authentication';
  if (/host key verification failed/iu.test(stderr)) return 'ssh-host-key';
  if (/could not resolve host|could not resolve hostname/iu.test(stderr)) return 'dns';
  if (
    /connection timed out|connection refused|connection reset|network is unreachable/iu.test(stderr)
  )
    return 'transport';
  if (/repository not found|repository .* does not exist/iu.test(stderr))
    return 'repository-unavailable';
  if (/no space left on device/iu.test(stderr)) return 'disk-full';
  if (/permission denied/iu.test(stderr)) return 'permission';
  if (/unable to create .*\.lock|another git process/iu.test(stderr)) return 'lock';
  return 'unknown';
}

/** retain classified subprocess evidence, never upstream prose, paths, or credentials. */
export default class GitCommandError extends Error {
  override name = 'GitCommandError';
  readonly category: string;
  readonly operation: string;
  readonly exitCode: number | null;

  constructor(operation: string, result: { exitCode: number | null; stderr: string }) {
    const safeOperation = operations.has(operation) ? operation : 'unknown';
    const category = classify(result.stderr);
    const exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode : null;
    super(`Git ${safeOperation} failed: category=${category} exit=${exitCode ?? 'terminated'}.`);
    this.category = category;
    this.operation = safeOperation;
    this.exitCode = exitCode;
  }

  get diagnosticCode(): string {
    return `git-${this.operation.replaceAll(' ', '-')}-${this.category}-exit-${this.exitCode ?? 'terminated'}`;
  }
}
