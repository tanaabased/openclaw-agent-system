import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import nodeErrorCode from '../utils/node-error-code.ts';
import {
  classifyCodexPathConfig,
  inspectCodexPathConfig,
  renderCodexPathConfig,
} from './codex-config.ts';
import type { AgentPathProjection } from './resolve.ts';
import WorkspaceGitignoreService from './workspace-gitignore-service.ts';

const gitignoreEntry = '.codex/config.toml';
const gitignoreBlock = {
  comment: '# Agent System local Codex configuration.',
  entries: [gitignoreEntry],
} as const;

export type CodexPathConfigStatus = 'created' | 'updated' | 'unchanged' | 'manual';

export interface CodexPathConfigInspection {
  gitignored: boolean;
  loginShellDisabled: boolean;
  ownership: 'absent' | 'managed' | 'manual' | 'user';
  pathMatches: boolean;
}

export interface CodexPathConfigReconcileResult extends CodexPathConfigInspection {
  gitignoreUpdated: boolean;
  status: CodexPathConfigStatus;
}

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error(`${path} must be a regular file and may not be a symbolic link.`);
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return undefined;
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

export interface CodexPathConfigServiceDependencies {
  gitignoreService?: Pick<WorkspaceGitignoreService, 'includes' | 'reconcile'>;
}

/** Own the generated Codex workspace config without overwriting manual configuration. */
export default class CodexPathConfigService {
  readonly #gitignoreService: Pick<WorkspaceGitignoreService, 'includes' | 'reconcile'>;

  constructor(dependencies: CodexPathConfigServiceDependencies = {}) {
    this.#gitignoreService = dependencies.gitignoreService ?? new WorkspaceGitignoreService();
  }

  async inspect(
    workspaceDir: string,
    projection: AgentPathProjection,
  ): Promise<CodexPathConfigInspection> {
    const configPath = join(workspaceDir, '.codex', 'config.toml');
    const source = await readRegularFile(configPath);
    const gitignored = await this.#gitignoreService.includes(workspaceDir, [gitignoreEntry]);
    if (source === undefined) {
      return {
        gitignored,
        loginShellDisabled: false,
        ownership: 'absent',
        pathMatches: false,
      };
    }
    const inspection = inspectCodexPathConfig(source, projection);
    return {
      gitignored,
      loginShellDisabled: inspection.loginShellDisabled,
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

    const gitignoreUpdated = await this.#gitignoreService.reconcile(workspaceDir, gitignoreBlock);
    return {
      gitignored: true,
      gitignoreUpdated,
      loginShellDisabled: true,
      ownership: 'managed',
      pathMatches: true,
      status,
    };
  }
}
