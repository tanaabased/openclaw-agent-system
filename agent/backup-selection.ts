import { execFile } from 'node:child_process';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import isPathContained from '../utils/is-path-contained.ts';
import nodeErrorCode from '../utils/node-error-code.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { BackupConfiguration } from '../manifest/backup-schema.ts';
import {
  BackupError,
  backupControlDirectory,
  backupDefaultOutput,
  type BackupPlan,
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

/** enumerate before git filtering so explicit includes can recover ignored descendants. */
export async function planWorkspaceBackup(options: {
  manifest: AgentManifest;
  workspaceDir: string;
  overrides?: BackupConfiguration;
  bound?: boolean;
  protectedPaths?: string[];
}): Promise<BackupPlan> {
  const workspaceDir = await realpath(options.workspaceDir);
  const configured = options.manifest.backup ?? {};
  const overrides = options.overrides ?? {};
  const settings = {
    output: await canonicalBackupPath(
      resolve(workspaceDir, overrides.output ?? configured.output ?? backupDefaultOutput),
    ),
    gitIgnore: overrides.gitIgnore ?? configured.gitIgnore ?? false,
    include: overrides.include ?? configured.include ?? [],
    exclude: overrides.exclude ?? configured.exclude ?? [],
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
  const protectedPaths = await Promise.all(
    [
      resolve(workspaceDir, backupDefaultOutput),
      resolve(workspaceDir, backupControlDirectory),
      settings.output,
      ...(options.protectedPaths ?? []),
    ].map(canonicalBackupPath),
  );
  if (protectedPaths.some((path) => isPathContained(path, workspaceDir))) {
    throw new BackupError(
      'backup-workspace-is-runtime-state',
      'The selected workspace is inside protected OpenClaw state. Choose a separate workspace.',
    );
  }
  if (
    (options.protectedPaths ?? []).some((path) => isPathContained(resolve(path), settings.output))
  ) {
    throw new BackupError(
      'backup-output-is-runtime-state',
      'The backup destination must not be inside live OpenClaw state.',
    );
  }
  const diagnostics: BackupPlan['diagnostics'] = [];
  const candidates: string[] = [];
  async function visit(directory: string) {
    if (!isPathContained(workspaceDir, await realpath(directory)))
      throw new BackupError(
        'backup-source-escaped',
        'A workspace directory changed or escaped during selection.',
      );
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(directory, entry.name);
      const workspacePath = relative(workspaceDir, path).split(sep).join('/');
      if (!safeBackupRelativePath(workspacePath))
        throw new BackupError(
          'backup-source-path-unsafe',
          `Unsupported workspace path: ${JSON.stringify(workspacePath)}.`,
        );
      const canonical = await canonicalBackupPath(path);
      if (
        backupPathProtected(path, protectedPaths) ||
        backupPathProtected(canonical, protectedPaths)
      )
        continue;
      const regenerableDirectory =
        entry.isDirectory() &&
        (entry.name === 'node_modules' ||
          (entry.name === '_cacache' && directory.endsWith('/.npm')));
      const mayInclude = settings.include.some((pattern) => {
        const prefix = pattern
          .split('/')
          .filter(
            (_, index, parts) => !parts.slice(0, index + 1).some((part) => /[?*[{]/u.test(part)),
          )
          .join('/');
        return (
          !prefix ||
          prefix === workspacePath ||
          prefix.startsWith(`${workspacePath}/`) ||
          workspacePath.startsWith(`${prefix}/`)
        );
      });
      if (regenerableDirectory && !mayInclude) continue;
      candidates.push(workspacePath);
      if (candidates.length > 100_000)
        throw new BackupError(
          'backup-inventory-too-large',
          'A workspace backup supports at most 100000 entries.',
        );
      if (entry.isDirectory()) await visit(path);
      else if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new BackupError(
          'backup-source-type-unsupported',
          `Unsupported workspace entry: ${workspacePath}.`,
        );
      }
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
      if (!/[?*[{]/u.test(pattern))
        throw new BackupError(
          'backup-required-file-missing',
          `An explicitly included path is missing: ${pattern}.`,
        );
      diagnostics.push({
        code: 'backup-include-unmatched',
        message: 'An include pattern matched no workspace entries.',
        path: pattern,
      });
    }
  }
  const ignored = new Set<string>();
  if (settings.gitIgnore) {
    try {
      await backupGit(workspaceDir, ['rev-parse', '--show-toplevel']);
      for (let index = 0; index < candidates.length; index += 1000) {
        const input = `${candidates.slice(index, index + 1000).join('\0')}\0`;
        try {
          const result = await backupGit(workspaceDir, ['check-ignore', '-z', '--stdin'], input);
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
  }
  const selected = new Set(
    candidates.filter(
      (path) =>
        ((!matches(path, backupRegenerablePatterns) && !ignored.has(path)) ||
          matches(path, settings.include)) &&
        !matches(path, settings.exclude),
    ),
  );
  for (const path of [...selected]) {
    const stats = await lstat(join(workspaceDir, path));
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
  return {
    agentId: options.manifest.agent.id,
    workspaceDir,
    settings,
    protectedPaths,
    files: [...selected].sort(),
    diagnostics,
    coverage: {
      stage: 'workspace-only',
      openclawState: 'unsupported',
      atomic: false,
      omittedPaths: protectedPaths,
      limitations: [
        'OpenClaw databases, sessions and runtime state are not captured.',
        'Out-of-workspace sources and external memory backends are not captured.',
        'Files can change during capture; this is not an atomic workspace snapshot.',
      ],
    },
  };
}
