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
