import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { GitHubCliConfiguration } from './config-schema.ts';

const maximumConfigBytes = 16 * 1024;

export type GitHubConfigReconcileStatus = 'created' | 'updated' | 'unchanged';

export interface GitHubConfigInspection {
  configDir: string;
  status: 'drift' | 'missing' | 'ready';
}

export interface GitHubConfigStoreDependencies {
  currentUid?: number;
  rootDir?: string;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function hasPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function renderConfig(configuration: GitHubCliConfiguration): string {
  return [
    `git_protocol: ${configuration.gitProtocol}`,
    'prompt: disabled',
    'prefer_editor_prompt: disabled',
    'pager: cat',
    `color_labels: ${configuration.colorLabels}`,
    `accessible_colors: ${configuration.accessibleColors}`,
    `spinner: ${configuration.spinner}`,
    `telemetry: ${configuration.telemetry}`,
    '',
  ].join('\n');
}

/** Persist one generated, token-free GitHub CLI config per Agent System agent. */
export default class GitHubConfigStore {
  readonly #currentUid: number | undefined;
  readonly #rootDir: string | undefined;

  constructor(dependencies: GitHubConfigStoreDependencies) {
    this.#currentUid = dependencies.currentUid;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
  }

  configDirectory(agentId: string): string {
    const paths = this.#paths(agentId);
    if (!paths) {
      throw new Error('The GitHub config store does not have a usable configuration directory.');
    }
    return paths.configDir;
  }

  async inspect(
    agentId: string,
    configuration: GitHubCliConfiguration,
  ): Promise<GitHubConfigInspection> {
    const paths = this.#paths(agentId);
    if (!paths) {
      throw new Error('The GitHub config store does not have a usable configuration directory.');
    }
    for (const directory of paths.directories) {
      const status = await this.#inspectDirectory(directory);
      if (status === 'missing') return { configDir: paths.configDir, status: 'missing' };
    }

    try {
      const stats = await lstat(paths.configPath);
      if (!stats.isFile()) {
        throw new Error('The generated GitHub config must be a regular file.');
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { configDir: paths.configDir, status: 'missing' };
      throw error;
    }

    let handle;
    try {
      handle = await open(paths.configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { configDir: paths.configDir, status: 'missing' };
      if (errorCode(error) === 'ELOOP') {
        throw new Error('The generated GitHub config may not be a symbolic link.', {
          cause: error,
        });
      }
      throw new Error('The generated GitHub config could not be opened safely.', { cause: error });
    }

    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error('The generated GitHub config must be a regular file.');
      if (!hasPrivateMode(stats.mode)) {
        throw new Error('The generated GitHub config must be private to the current user.');
      }
      if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
        throw new Error('The generated GitHub config must be owned by the current user.');
      }
      if (stats.size > maximumConfigBytes) {
        throw new Error('The generated GitHub config exceeds the supported size limit.');
      }
      const contents = await handle.readFile('utf8');
      return {
        configDir: paths.configDir,
        status: contents === renderConfig(configuration) ? 'ready' : 'drift',
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async reconcile(
    agentId: string,
    configuration: GitHubCliConfiguration,
  ): Promise<{ configDir: string; status: GitHubConfigReconcileStatus }> {
    const paths = this.#paths(agentId);
    if (!paths) {
      throw new Error('The GitHub config store does not have a usable configuration directory.');
    }
    for (const directory of paths.directories) await this.#ensureDirectory(directory);

    const inspection = await this.inspect(agentId, configuration);
    if (inspection.status === 'ready') {
      return { configDir: paths.configDir, status: 'unchanged' };
    }

    const temporaryPath = join(paths.configDir, `.config.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(renderConfig(configuration), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, paths.configPath);
      return {
        configDir: paths.configDir,
        status: inspection.status === 'missing' ? 'created' : 'updated',
      };
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #ensureDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: 0o700, recursive: path === this.#rootDir });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    await this.#inspectDirectory(path);
  }

  async #inspectDirectory(path: string): Promise<'missing' | 'ready'> {
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'missing';
      throw new Error('A GitHub config directory could not be inspected.', { cause: error });
    }
    if (!stats.isDirectory()) {
      throw new Error('GitHub config directories must be real directories.');
    }
    if (!hasPrivateMode(stats.mode)) {
      throw new Error('GitHub config directories must be private to the current user.');
    }
    if (this.#currentUid !== undefined && stats.uid !== this.#currentUid) {
      throw new Error('GitHub config directories must be owned by the current user.');
    }
    return 'ready';
  }

  #paths(agentId: string):
    | {
        configDir: string;
        configPath: string;
        directories: string[];
      }
    | undefined {
    if (!this.#rootDir || !/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) return undefined;
    const agentDir = join(this.#rootDir, agentId);
    const toolsDir = join(agentDir, 'tools');
    const configDir = join(toolsDir, 'gh');
    return {
      configDir,
      configPath: join(configDir, 'config.yml'),
      directories: [this.#rootDir, agentDir, toolsDir, configDir],
    };
  }
}
