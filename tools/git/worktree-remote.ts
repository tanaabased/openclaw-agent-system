const scpRemotePattern = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([^\s]+)$/u;

function hasControlOrShellSyntax(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 || ';&|<>`$(){}[]'.includes(character);
  });
}

/** Normalize one network Git remote without imposing a host or repository allowlist. */
export default function normalizeGitWorktreeRemote(input: string): string {
  if (!input || input !== input.trim() || input.startsWith('-') || hasControlOrShellSyntax(input)) {
    throw new Error('The Git clone source is invalid.');
  }
  const scpRemote = scpRemotePattern.exec(input);
  if (scpRemote) return `${scpRemote[1]}@${scpRemote[2]?.toLowerCase()}:${scpRemote[3]}`;

  let remote: URL;
  try {
    remote = new URL(input);
  } catch {
    throw new Error('The Git clone source must be a supported network remote.');
  }
  if (!['git:', 'https:', 'ssh:'].includes(remote.protocol) || !remote.hostname) {
    throw new Error('The Git clone source must be a supported network remote.');
  }
  if (
    remote.password ||
    remote.search ||
    remote.hash ||
    (remote.protocol === 'https:' && remote.username)
  ) {
    throw new Error('The Git clone source may not contain embedded credentials or parameters.');
  }
  return remote.href;
}

/** compare transport-independent network identity, never a local marker or basename. */
export function gitRemoteIdentity(input: string): string {
  const normalized = normalizeGitWorktreeRemote(input);
  const scp = scpRemotePattern.exec(normalized);
  const url = scp ? new URL(`ssh://${scp[1]}@${scp[2]}/${scp[3]}`) : new URL(normalized);
  const path = url.pathname
    .replace(/^\//u, '')
    .replace(/\/$/u, '')
    .replace(/\.git$/iu, '');
  const segments = path.split('/');
  if (
    segments.length < 2 ||
    segments.some((part) => !/^[A-Za-z0-9._-]+$/u.test(part) || part === '.' || part === '..')
  )
    throw new Error('The Git repository identity is invalid.');
  const host = url.hostname.toLowerCase();
  if (url.port) throw new Error('The Git repository identity uses an unsupported port.');
  return host + '/' + (host === 'github.com' ? path.toLowerCase() : path);
}

/** Convert a provider-validated canonical GitHub HTTPS remote to its SSH equivalent. */
export function githubSshWorktreeRemote(input: string): string {
  let normalized: string;
  try {
    normalized = normalizeGitWorktreeRemote(input);
  } catch {
    throw new Error('The GitHub clone source must be canonical HTTPS.');
  }
  let remote: URL;
  try {
    remote = new URL(normalized);
  } catch {
    throw new Error('The GitHub clone source must be canonical HTTPS.');
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git$/u.exec(remote.pathname);
  if (
    remote.protocol !== 'https:' ||
    remote.hostname !== 'github.com' ||
    remote.port ||
    remote.username ||
    remote.password ||
    !match
  ) {
    throw new Error('The GitHub clone source must be canonical HTTPS.');
  }
  return `git@github.com:${match[1]}/${match[2]}.git`;
}

/** Prefer SSH for a canonical GitHub HTTPS remote and preserve other valid remotes. */
export function preferGitHubSshWorktreeRemote(input: string): string {
  const normalized = normalizeGitWorktreeRemote(input);
  try {
    return githubSshWorktreeRemote(normalized);
  } catch {
    return normalized;
  }
}

/** retain the provider's repository spelling for the configured checkout destination. */
export function gitRemoteRepositoryName(input: string): string {
  gitRemoteIdentity(input);
  return normalizeGitWorktreeRemote(input)
    .replace(/\/$/u, '')
    .split('/')
    .at(-1)!
    .replace(/\.git$/iu, '');
}
