import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  classifyCodexPathConfig,
  inspectCodexPathConfig,
  renderCodexPathConfig,
} from '../utils/codex-path-config.ts';
import type { AgentPathProjection } from '../utils/resolve-agent-paths.ts';

const gitignoreEntry = '.codex/config.toml';
const gitignoreBlock = `# Agent System local Codex configuration.\n${gitignoreEntry}\n`;

export type CodexPathConfigStatus = 'created' | 'updated' | 'unchanged' | 'manual';

export interface CodexPathConfigInspection {
  gitignored: boolean;
  ownership: 'absent' | 'managed' | 'manual' | 'user';
  pathMatches: boolean;
}

export interface CodexPathConfigReconcileResult extends CodexPathConfigInspection {
  gitignoreUpdated: boolean;
  status: CodexPathConfigStatus;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`${path} must be a regular file and may not be a symbolic link.`);
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, source: string, mode = 0o600): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function existingFileMode(path: string, fallback: number): Promise<number> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`${path} must be a regular file and may not be a symbolic link.`);
    }
    return stats.mode & 0o777;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return fallback;
    throw error;
  }
}

function hasGitignoreEntry(source: string | undefined): boolean {
  return (
    source
      ?.split(/\r?\n/u)
      .map((line) => line.trim())
      .includes(gitignoreEntry) === true
  );
}

/** Own the generated Codex workspace config without overwriting manual configuration. */
export default class CodexPathConfigService {
  async inspect(
    workspaceDir: string,
    projection: AgentPathProjection,
  ): Promise<CodexPathConfigInspection> {
    const configPath = join(workspaceDir, '.codex', 'config.toml');
    const source = await readRegularFile(configPath);
    const gitignoreSource = await readRegularFile(join(workspaceDir, '.gitignore'));
    if (source === undefined) {
      return {
        gitignored: hasGitignoreEntry(gitignoreSource),
        ownership: 'absent',
        pathMatches: false,
      };
    }
    const inspection = inspectCodexPathConfig(source, projection);
    return {
      gitignored: hasGitignoreEntry(gitignoreSource),
      ownership: inspection.ownership,
      pathMatches: inspection.pathMatches,
    };
  }

  async reconcile(
    workspaceDir: string,
    projection: AgentPathProjection,
  ): Promise<CodexPathConfigReconcileResult> {
    const codexDir = join(workspaceDir, '.codex');
    const configPath = join(codexDir, 'config.toml');
    const existingSource = await readRegularFile(configPath);
    if (existingSource !== undefined && classifyCodexPathConfig(existingSource) !== 'managed') {
      const inspection = await this.inspect(workspaceDir, projection);
      return { ...inspection, gitignoreUpdated: false, status: 'manual' };
    }

    await mkdir(codexDir, { recursive: true });
    const codexStats = await lstat(codexDir);
    if (!codexStats.isDirectory()) {
      throw new Error('The workspace .codex path must be a real directory.');
    }
    const desiredSource = renderCodexPathConfig(projection.path);
    const status: CodexPathConfigStatus =
      existingSource === undefined
        ? 'created'
        : existingSource === desiredSource
          ? 'unchanged'
          : 'updated';
    if (status !== 'unchanged') await writeAtomic(configPath, desiredSource);

    const gitignorePath = join(workspaceDir, '.gitignore');
    const gitignoreSource = await readRegularFile(gitignorePath);
    const gitignored = hasGitignoreEntry(gitignoreSource);
    if (!gitignored) {
      const separator = gitignoreSource && !gitignoreSource.endsWith('\n\n') ? '\n' : '';
      const mode = await existingFileMode(gitignorePath, 0o644);
      await writeAtomic(
        gitignorePath,
        `${gitignoreSource ?? ''}${separator}${gitignoreBlock}`,
        mode,
      );
    }
    return {
      gitignored: true,
      gitignoreUpdated: !gitignored,
      ownership: 'managed',
      pathMatches: true,
      status,
    };
  }
}
