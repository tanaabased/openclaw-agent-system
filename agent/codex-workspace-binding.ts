import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

import discoverManifest from '../manifest/discover.ts';
import { loadDiscoveredManifest, type AgentManifestLoadResult } from '../manifest/load.ts';

export const codexWorkspaceBindingFileName = 'workspace-binding.json';
const maximumBindingBytes = 16 * 1024;

export interface CodexWorkspaceBinding {
  schemaVersion: 1;
  workspaceDir: string;
}

export type CodexWorkspacePreview =
  | {
      status: 'ready';
      workspaceDir: string;
      manifest: Exclude<AgentManifestLoadResult, { status: 'unresolved' }>;
    }
  | {
      status: 'invalid-workspace';
      workspaceDir: string;
      code: 'workspace-missing' | 'workspace-not-directory' | 'workspace-inspection-failed';
      message: string;
    };

export type CodexWorkspaceBindingInspection =
  | { status: 'unbound'; path: string }
  | { status: 'invalid'; path: string; code: string; message: string }
  | {
      status: 'bound';
      path: string;
      binding: CodexWorkspaceBinding;
      preview: CodexWorkspacePreview;
    };

export type BindCodexWorkspaceResult =
  | {
      status: 'bound';
      path: string;
      binding: CodexWorkspaceBinding;
      preview: CodexWorkspacePreview;
    }
  | { status: 'confirmation-required'; path: string; preview: CodexWorkspacePreview }
  | {
      status: 'rejected';
      path: string;
      preview: Extract<CodexWorkspacePreview, { status: 'invalid-workspace' }>;
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function codexWorkspaceBindingPath(pluginData: string): string {
  return join(resolve(pluginData), codexWorkspaceBindingFileName);
}

function parseBinding(value: unknown): CodexWorkspaceBinding | undefined {
  if (!record(value)) return undefined;
  if (Object.keys(value).sort().join(',') !== 'schemaVersion,workspaceDir') return undefined;
  if (value.schemaVersion !== 1 || typeof value.workspaceDir !== 'string') return undefined;
  if (!isAbsolute(value.workspaceDir) || normalize(value.workspaceDir) !== value.workspaceDir) {
    return undefined;
  }
  return { schemaVersion: 1, workspaceDir: value.workspaceDir };
}

/** Resolve a selected directory and report its current manifest state. */
export async function previewCodexWorkspace(workspaceDir: string): Promise<CodexWorkspacePreview> {
  const requestedWorkspace = resolve(workspaceDir);
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(requestedWorkspace);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: 'invalid-workspace',
      workspaceDir: requestedWorkspace,
      code: code === 'ENOENT' ? 'workspace-missing' : 'workspace-inspection-failed',
      message:
        code === 'ENOENT'
          ? 'The selected workspace does not exist.'
          : 'The selected workspace could not be inspected.',
    };
  }

  try {
    if (!(await stat(canonicalWorkspace)).isDirectory()) {
      return {
        status: 'invalid-workspace',
        workspaceDir: canonicalWorkspace,
        code: 'workspace-not-directory',
        message: 'The selected workspace must be a directory.',
      };
    }
  } catch {
    return {
      status: 'invalid-workspace',
      workspaceDir: canonicalWorkspace,
      code: 'workspace-inspection-failed',
      message: 'The selected workspace could not be inspected.',
    };
  }

  const discovery = await discoverManifest(canonicalWorkspace);
  return {
    status: 'ready',
    workspaceDir: canonicalWorkspace,
    manifest: await loadDiscoveredManifest(discovery),
  };
}

/** Read the single persisted Codex workspace binding and preview its live state. */
export async function inspectCodexWorkspaceBinding(
  pluginData: string,
): Promise<CodexWorkspaceBindingInspection> {
  const path = codexWorkspaceBindingPath(pluginData);
  let bindingStats;
  try {
    bindingStats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'unbound', path };
    return {
      status: 'invalid',
      path,
      code: 'binding-read-failed',
      message: 'The Codex workspace binding could not be read.',
    };
  }

  if (!bindingStats.isFile()) {
    return {
      status: 'invalid',
      path,
      code: 'binding-not-regular-file',
      message: 'The Codex workspace binding must be a regular file.',
    };
  }
  if (bindingStats.size > maximumBindingBytes) {
    return {
      status: 'invalid',
      path,
      code: 'binding-too-large',
      message: 'The Codex workspace binding is too large.',
    };
  }

  let contents: Buffer;
  try {
    contents = await readFile(path);
  } catch {
    return {
      status: 'invalid',
      path,
      code: 'binding-read-failed',
      message: 'The Codex workspace binding could not be read.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)) as unknown;
  } catch {
    return {
      status: 'invalid',
      path,
      code: 'binding-invalid',
      message: 'The Codex workspace binding is malformed.',
    };
  }

  const binding = parseBinding(parsed);
  if (!binding) {
    return {
      status: 'invalid',
      path,
      code: 'binding-invalid',
      message: 'The Codex workspace binding is malformed.',
    };
  }

  return {
    status: 'bound',
    path,
    binding,
    preview: await previewCodexWorkspace(binding.workspaceDir),
  };
}

/** Persist one confirmed workspace pointer, replacing any earlier binding. */
export async function bindCodexWorkspace(
  pluginData: string,
  workspaceDir: string,
  options: { allowInactive?: boolean } = {},
): Promise<BindCodexWorkspaceResult> {
  const path = codexWorkspaceBindingPath(pluginData);
  const preview = await previewCodexWorkspace(workspaceDir);
  if (preview.status === 'invalid-workspace') return { status: 'rejected', path, preview };
  if (preview.manifest.status !== 'loaded' && options.allowInactive !== true) {
    return { status: 'confirmation-required', path, preview };
  }

  const binding: CodexWorkspaceBinding = {
    schemaVersion: 1,
    workspaceDir: preview.workspaceDir,
  };
  const temporaryPath = join(dirname(path), `.${codexWorkspaceBindingFileName}.${randomUUID()}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(binding, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return { status: 'bound', path, binding, preview };
}

/** Remove the active pointer without changing the workspace or its manifest. */
export async function unbindCodexWorkspace(
  pluginData: string,
): Promise<{ status: 'unbound'; path: string }> {
  const path = codexWorkspaceBindingPath(pluginData);
  await rm(path, { force: true });
  return { status: 'unbound', path };
}
