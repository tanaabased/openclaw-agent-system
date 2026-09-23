import { lstat, mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import readRegularFile from './read-regular-file.ts';
import writeAtomic from './write-atomic.ts';
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
  baseline: string[];
  gitignored: boolean;
  loginShellDisabled: boolean;
  managedPrefixesMatch: boolean;
  missingBaselineEntries: string[];
  ownership: 'absent' | 'managed' | 'manual' | 'user';
  pathMatches: boolean;
  pathStatus: 'valid' | 'missing' | 'malformed';
}

export interface CodexPathConfigReconcileResult extends CodexPathConfigInspection {
  baselineAdded: string[];
  baselineRemoved: string[];
  gitignoreUpdated: boolean;
  operation: 'append' | 'rebuild';
  status: CodexPathConfigStatus;
}

export interface CodexPathConfigOptions {
  previousManagedPaths?: readonly string[];
  rebuildBaseline?: boolean;
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
    options: CodexPathConfigOptions = {},
  ): Promise<CodexPathConfigInspection> {
    const configPath = join(workspaceDir, '.codex', 'config.toml');
    const source = await readRegularFile(configPath);
    const gitignored = await this.#gitignoreService.includes(workspaceDir, [gitignoreEntry]);
    if (source === undefined) {
      return {
        baseline: [],
        gitignored,
        loginShellDisabled: false,
        managedPrefixesMatch: false,
        missingBaselineEntries: [...projection.baseline],
        ownership: 'absent',
        pathMatches: false,
        pathStatus: 'missing',
      };
    }
    const inspection = inspectCodexPathConfig(source, projection, options.previousManagedPaths);
    return {
      ...inspection,
      gitignored,
    };
  }

  async reconcile(
    workspaceDir: string,
    projection: AgentPathProjection,
    options: CodexPathConfigOptions = {},
  ): Promise<CodexPathConfigReconcileResult> {
    const codexDir = join(workspaceDir, '.codex');
    const configPath = join(codexDir, 'config.toml');
    const existingSource = await readRegularFile(configPath);
    if (existingSource !== undefined && classifyCodexPathConfig(existingSource) !== 'managed') {
      const inspection = await this.inspect(workspaceDir, projection, options);
      return {
        ...inspection,
        baselineAdded: [],
        baselineRemoved: [],
        gitignoreUpdated: false,
        operation: options.rebuildBaseline ? 'rebuild' : 'append',
        status: 'manual',
      };
    }

    await mkdir(codexDir, { recursive: true });
    const codexStats = await lstat(codexDir);
    if (!codexStats.isDirectory()) {
      throw new Error('The workspace .codex path must be a real directory.');
    }
    const existingInspection =
      existingSource === undefined
        ? undefined
        : inspectCodexPathConfig(existingSource, projection, options.previousManagedPaths);
    const existingBaseline =
      existingInspection?.pathStatus === 'valid' ? [...new Set(existingInspection.baseline)] : [];
    const baseline = options.rebuildBaseline
      ? [...projection.baseline]
      : [
          ...existingBaseline,
          ...projection.baseline.filter((entry) => !existingBaseline.includes(entry)),
        ];
    const managedPaths = projection.entries.map(({ path }) => path);
    const desiredSource = renderCodexPathConfig([...managedPaths, ...baseline].join(delimiter));
    const status: CodexPathConfigStatus =
      existingSource === undefined
        ? 'created'
        : existingSource === desiredSource
          ? 'unchanged'
          : 'updated';
    if (status !== 'unchanged') await writeAtomic(configPath, desiredSource, 0o600);

    const gitignoreUpdated = await this.#gitignoreService.reconcile(workspaceDir, gitignoreBlock);
    const baselineSet = new Set(baseline);
    const existingBaselineSet = new Set(existingBaseline);
    return {
      baseline,
      baselineAdded: baseline.filter((entry) => !existingBaselineSet.has(entry)),
      baselineRemoved: existingBaseline.filter((entry) => !baselineSet.has(entry)),
      gitignored: true,
      gitignoreUpdated,
      loginShellDisabled: true,
      managedPrefixesMatch: true,
      missingBaselineEntries: [],
      operation: options.rebuildBaseline ? 'rebuild' : 'append',
      ownership: 'managed',
      pathMatches: true,
      pathStatus: 'valid',
      status,
    };
  }
}
