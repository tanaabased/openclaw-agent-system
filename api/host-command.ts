import { readdir, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveToolExecutable } from './cli-runner.ts';
import isPathContained from '../utils/is-path-contained.ts';

// Host authentication may use ordinary files; inherited agent tokens and overrides never survive.
const hostEnvironmentNames = [
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

/** Prepare an opt-in host route without managed launchers, credentials, or identity. */
export async function prepareHostCommand(
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  excludedDirectories: readonly string[] = [],
): Promise<{ executable: string; environment: Record<string, string> }> {
  const excluded = await Promise.all(
    [
      fileURLToPath(new URL('../bin', import.meta.url)),
      ...(environment.AGENT_SYSTEM_TOOL_LAUNCHER_DIR
        ? [environment.AGENT_SYSTEM_TOOL_LAUNCHER_DIR]
        : []),
      ...excludedDirectories,
    ].map(async (path) => {
      if (!isAbsolute(path)) throw new Error('Invalid managed executable directory.');
      return realpath(path).catch(() => path);
    }),
  );
  const directories: string[] = [];
  for (const path of (environment.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(path)) continue;
    const canonical = await realpath(path).catch(() => undefined);
    if (!canonical || excluded.some((root) => isPathContained(root, canonical))) continue;
    directories.push(canonical);
  }
  const resolvedExecutable = await resolveToolExecutable(
    executable,
    directories.join(delimiter),
    excluded,
  );
  const childDirectories: string[] = [];
  for (const directory of new Set(directories)) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
    if (!entries) continue;
    const targets = await Promise.all(
      entries
        .filter((entry) => entry.isSymbolicLink())
        .map((entry) => realpath(join(directory, entry.name)).catch(() => undefined)),
    );
    // Keep the already selected absolute executable, but prevent descendants re-entering a shim alias.
    if (
      !targets.some((target) => target && excluded.some((root) => isPathContained(root, target)))
    ) {
      childDirectories.push(directory);
    }
  }
  const childEnvironment: Record<string, string> = { PATH: childDirectories.join(delimiter) };
  for (const name of hostEnvironmentNames) {
    const value = environment[name];
    if (value !== undefined) childEnvironment[name] = value;
  }
  return {
    executable: resolvedExecutable,
    environment: childEnvironment,
  };
}

/** Replace the launcher, retaining its descriptors, pid, exit status, and signal semantics. */
export default async function runHostCommand(
  executable: string,
  argv: string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  excludedDirectories: readonly string[],
): Promise<void> {
  const command = await prepareHostCommand(executable, environment, excludedDirectories);
  if (!process.execve)
    throw new Error('Host command handoff requires a supported Node.js runtime.');
  process.execve(command.executable, [command.executable, ...argv], command.environment);
}
