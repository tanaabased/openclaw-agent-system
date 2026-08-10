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
