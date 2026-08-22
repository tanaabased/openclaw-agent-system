import { resolveToolExecutable } from '../../api/cli-runner.ts';

export interface GitExtensionResolverDependencies {
  excludedExecutableDirectories?: readonly string[];
  path: string;
  resolveExecutable?: typeof resolveToolExecutable;
}

/** Resolve only explicit external git-* helpers, never repository aliases. */
export default function createGitExtensionResolver(
  dependencies: GitExtensionResolverDependencies,
): (name: string) => Promise<boolean> {
  const resolveExecutable = dependencies.resolveExecutable ?? resolveToolExecutable;
  return async (name) => {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) return false;
    try {
      await resolveExecutable(
        `git-${name}`,
        dependencies.path,
        dependencies.excludedExecutableDirectories,
      );
      return true;
    } catch {
      return false;
    }
  };
}
