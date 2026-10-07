import { execFile } from 'node:child_process';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import isPathContained from '../utils/is-path-contained.ts';
import nodeErrorCode from '../utils/node-error-code.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { BackupConfiguration } from '../manifest/backup-schema.ts';
import backupDirectoryRelevant from './backup-directory-relevant.ts';
import {
  BackupError,
  backupControlDirectory,
  backupDefaultOutput,
  type BackupSettings,
  type BackupPlan,
  type BackupRuntimeProtection,
} from './backup-types.ts';

const executeFile = promisify(execFile);
export const backupRegenerablePatterns = [
  '**/node_modules/**',
  '**/.npm/_cacache/**',
  '**/.eslintcache',
];

/** use only git's local metadata commands, without managed credentials or launchers. */
export async function backupGit(workspaceDir: string, args: string[], input?: string) {
  const child = executeFile('/usr/bin/git', ['--no-optional-locks', '-C', workspaceDir, ...args], {
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    encoding: 'utf8',
  });
  if (input !== undefined) child.child.stdin?.end(input);
  return child;
}

/** resolve existing aliases even when the final destination has not been created. */
export async function canonicalBackupPath(path: string): Promise<string> {
  const pending: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      return resolve(await realpath(current), ...pending);
    } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      pending.unshift(relative(parent, current));
      current = parent;
    }
  }
}

export function safeBackupRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !/[:\\]/u.test(path) &&
    !Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function matches(path: string, patterns: string[]): boolean {
  const segments = path.split('/');
  return patterns.some((pattern) =>
    segments.some((_, index) => matchesGlob(segments.slice(0, index + 1).join('/'), pattern)),
  );
}

export function backupPathProtected(path: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((root) => isPathContained(root, path));
}

/** resolve manifest defaults and explicit CLI replacements before filesystem selection. */
export function resolveBackupConfiguration(
  configured: BackupConfiguration = {},
  overrides: BackupConfiguration = {},
): BackupSettings {
  return {
    output: overrides.output ?? configured.output ?? backupDefaultOutput,
    gitIgnore: overrides.gitIgnore ?? configured.gitIgnore ?? false,
    openclawState: overrides.openclawState ?? configured.openclawState ?? 'auto',
    include: overrides.include ?? configured.include ?? [],
    exclude: overrides.exclude ?? configured.exclude ?? [],
  };
}

/** prune irrelevant trees while retaining explicitly included ignored descendants. */
export async function planWorkspaceBackup(options: {
  manifest: AgentManifest;
  workspaceDir: string;
  overrides?: BackupConfiguration;
  bound?: boolean;
  protectedPaths?: string[];
  runtimeProtection?: BackupRuntimeProtection;
}): Promise<BackupPlan> {
  const workspaceDir = await realpath(options.workspaceDir);
  const configured = options.manifest.backup ?? {};
  const configuration = resolveBackupConfiguration(configured, options.overrides);
  const settings = {
    ...configuration,
    output: await canonicalBackupPath(resolve(workspaceDir, configuration.output)),
  };
  for (const pattern of [...settings.include, ...settings.exclude]) {
    if (
      !pattern ||
      isAbsolute(pattern) ||
      pattern.includes('\\') ||
      pattern.includes('\0') ||
      pattern.includes('\r') ||
      pattern.includes('\n') ||
      pattern.split('/').includes('..')
    ) {
      throw new BackupError(
        'backup-pattern-invalid',
        `Use a workspace-relative selection pattern: ${JSON.stringify(pattern)}.`,
      );
    }
  }
  if (isPathContained(settings.output, workspaceDir)) {
    throw new BackupError(
      'backup-output-contains-workspace',
      'The backup destination cannot be the workspace or one of its ancestors.',
    );
  }
  const configuredOutput = await canonicalBackupPath(
    resolve(workspaceDir, configured.output ?? backupDefaultOutput),
  );
  if (
    options.bound &&
    !isPathContained(workspaceDir, settings.output) &&
    settings.output !== configuredOutput
  ) {
    throw new BackupError(
      'backup-output-outside-scope',
      'A bound caller must use the configured backup destination or a contained workspace directory.',
    );
  }
  const stateDir = options.runtimeProtection?.stateDir
    ? await canonicalBackupPath(options.runtimeProtection.stateDir)
    : undefined;
  const agentDir = options.runtimeProtection?.agentDir
    ? await canonicalBackupPath(options.runtimeProtection.agentDir)
    : undefined;
  const runtimeWorkspace = options.runtimeProtection?.workspaceDir
    ? await canonicalBackupPath(options.runtimeProtection.workspaceDir)
    : undefined;
  // only the host-resolved workspace may sit beneath the state root; runtime-only paths stay protected.
  const stateWorkspace =
    stateDir !== undefined &&
    workspaceDir !== stateDir &&
    workspaceDir === runtimeWorkspace &&
    isPathContained(stateDir, workspaceDir);
  const runtimePaths = await Promise.all(
    [
      ...(options.protectedPaths ?? []),
      ...(options.runtimeProtection?.paths ?? []),
      ...(agentDir ? [agentDir] : []),
      ...(stateDir && !stateWorkspace ? [stateDir] : []),
    ].map(canonicalBackupPath),
  );
  const protectedPaths = await Promise.all(
    [
      resolve(workspaceDir, backupDefaultOutput),
      resolve(workspaceDir, backupControlDirectory),
      settings.output,
      ...runtimePaths,
    ].map(canonicalBackupPath),
  );
  if (protectedPaths.some((path) => isPathContained(path, workspaceDir))) {
    throw new BackupError(
      'backup-workspace-is-runtime-state',
      'The selected workspace is inside protected OpenClaw state. Choose a separate workspace.',
    );
  }
  if (
    runtimePaths.some((path) => isPathContained(path, settings.output)) ||
    (stateDir &&
      isPathContained(stateDir, settings.output) &&
      !(stateWorkspace && isPathContained(workspaceDir, settings.output)))
  ) {
    throw new BackupError(
      'backup-output-is-runtime-state',
      'The backup destination must not be inside live OpenClaw state.',
    );
  }
  const diagnostics: BackupPlan['diagnostics'] = [];
  const candidates: string[] = [];
  const excludedDirectories: string[] = [];
  const selected = new Set<string>();
  const trackedDirectories = new Set<string>();
  if (settings.gitIgnore) {
    try {
      await backupGit(workspaceDir, ['rev-parse', '--show-toplevel']);
      const tracked = await backupGit(workspaceDir, ['ls-files', '-z', '--cached', '--', '.']);
      for (const path of tracked.stdout.split('\0').filter(Boolean)) {
        let parent = dirname(path);
        while (parent !== '.') {
          trackedDirectories.add(parent);
          parent = dirname(parent);
        }
      }
    } catch {
      throw new BackupError(
        'backup-git-ignore-unavailable',
        'Git-ignore selection requires readable local Git metadata.',
      );
    }
  }
  async function ignoredPaths(paths: string[]): Promise<Set<string>> {
    const ignored = new Set<string>();
    if (!settings.gitIgnore) return ignored;
    try {
      for (let index = 0; index < paths.length; index += 1000) {
        try {
          const result = await backupGit(
            workspaceDir,
            ['check-ignore', '-z', '--stdin'],
            `${paths.slice(index, index + 1000).join('\0')}\0`,
          );
          for (const path of result.stdout.split('\0').filter(Boolean)) ignored.add(path);
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
        }
      }
    } catch {
      throw new BackupError(
        'backup-git-ignore-unavailable',
        'Git-ignore selection requires readable local Git metadata.',
      );
    }
    return ignored;
  }
  async function visit(directory: string) {
    if (!isPathContained(workspaceDir, await realpath(directory)))
      throw new BackupError(
        'backup-source-escaped',
        'A workspace directory changed or escaped during selection.',
      );
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = entries
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => {
        const path = join(directory, entry.name);
        const workspacePath = relative(workspaceDir, path).split(sep).join('/');
        if (!safeBackupRelativePath(workspacePath))
          throw new BackupError(
            'backup-source-path-unsafe',
            `Unsupported workspace path: ${JSON.stringify(workspacePath)}.`,
          );
        return { entry, path, workspacePath };
      });
    const ignored = await ignoredPaths(
      paths
        .filter(
          ({ path, workspacePath }) =>
            !backupPathProtected(path, protectedPaths) && !matches(workspacePath, settings.exclude),
        )
        .map(({ workspacePath }) => workspacePath),
    );
    for (const { entry, path, workspacePath } of paths) {
      if (backupPathProtected(path, protectedPaths)) continue;
      if (matches(workspacePath, settings.exclude)) {
        candidates.push(workspacePath);
        if (entry.isDirectory()) excludedDirectories.push(workspacePath);
        continue;
      }
      const canonical = await canonicalBackupPath(path);
      if (backupPathProtected(canonical, protectedPaths)) continue;
      const regenerableDirectory =
        entry.isDirectory() &&
        (entry.name === 'node_modules' ||
          (entry.name === '_cacache' && directory.endsWith('/.npm')));
      const mayInclude =
        entry.isDirectory() && backupDirectoryRelevant(workspacePath, settings.include);
      if (regenerableDirectory && !mayInclude) continue;
      candidates.push(workspacePath);
      if (
        (!matches(workspacePath, backupRegenerablePatterns) && !ignored.has(workspacePath)) ||
        matches(workspacePath, settings.include)
      )
        selected.add(workspacePath);
      if (ignored.has(workspacePath) && !mayInclude && !trackedDirectories.has(workspacePath))
        continue;
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(workspaceDir);
  for (const pattern of settings.include) {
    if (!candidates.some((path) => matches(path, [pattern]))) {
      const requested = resolve(workspaceDir, pattern);
      if (
        backupPathProtected(requested, protectedPaths) ||
        backupPathProtected(await canonicalBackupPath(requested), protectedPaths)
      )
        continue;
      if (!/[?*[{]|[!+@]\(/u.test(pattern)) {
        if (
          await lstat(requested).catch((error: unknown) => {
            if (nodeErrorCode(error) === 'ENOENT' || nodeErrorCode(error) === 'ENOTDIR')
              return undefined;
            throw error;
          })
        )
          continue;
        throw new BackupError(
          'backup-required-file-missing',
          `An explicitly included path is missing: ${pattern}.`,
        );
      }
      // a pruned exclusion cannot prove that a potentially matching glob is absent.
      if (excludedDirectories.some((directory) => backupDirectoryRelevant(directory, [pattern])))
        continue;
      diagnostics.push({
        code: 'backup-include-unmatched',
        message: 'An include pattern matched no workspace entries.',
        path: pattern,
      });
    }
  }
  for (const path of [...selected]) {
    const stats = await lstat(join(workspaceDir, path));
    if (!stats.isDirectory() && !stats.isFile() && !stats.isSymbolicLink())
      throw new BackupError(
        'backup-source-type-unsupported',
        `Unsupported workspace entry: ${path}.`,
      );
    if (stats.isSymbolicLink()) {
      const target = await realpath(join(workspaceDir, path)).catch(() => undefined);
      const linkTarget = await readlink(join(workspaceDir, path));
      if (
        isAbsolute(linkTarget) ||
        !target ||
        !isPathContained(workspaceDir, target) ||
        backupPathProtected(target, protectedPaths) ||
        !selected.has(relative(workspaceDir, target).split(sep).join('/'))
      ) {
        selected.delete(path);
        diagnostics.push({
          code: 'backup-symlink-omitted',
          message: 'A link outside the selected payload was omitted.',
          path,
        });
      }
    }
  }
  // structural parent directories do not restore excluded file contents.
  for (const path of [...selected]) {
    let parent = dirname(path);
    while (parent !== '.') {
      selected.add(parent);
      parent = dirname(parent);
    }
  }
  if (selected.size > 100_000)
    throw new BackupError(
      'backup-inventory-too-large',
      'A workspace backup supports at most 100000 entries.',
    );
  return {
    agentId: options.manifest.agent.id,
    workspaceDir,
    settings,
    ...(agentDir ? { agentDir } : {}),
    ...(options.runtimeProtection?.openclawVersion
      ? { openclawVersion: options.runtimeProtection.openclawVersion }
      : {}),
    protectedPaths,
    files: [...selected].sort(),
    diagnostics,
    coverage: {
      stage: 'workspace-only',
      openclawState: settings.openclawState === 'off' ? 'off' : 'pending',
      atomic: false,
      omittedPaths: protectedPaths,
      limitations: [
        ...(settings.openclawState === 'off'
          ? ['The OpenClaw agent database was explicitly omitted.']
          : []),
        'Out-of-workspace sources and external memory backends are not captured.',
        'Files can change during capture; this is not an atomic workspace snapshot.',
      ],
    },
  };
}
