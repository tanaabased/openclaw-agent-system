import { isAbsolute, join, resolve } from 'node:path';

/** resolve installation state from the host, never from manifest-projected environment. */
export default function installationConfigRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const xdg = environment.XDG_CONFIG_HOME?.trim();
  if (xdg) return isAbsolute(xdg) ? join(resolve(xdg), 'tanaab', 'agent-system') : undefined;
  const home = environment.HOME?.trim();
  return home && isAbsolute(home)
    ? join(resolve(home), '.config', 'tanaab', 'agent-system')
    : undefined;
}
