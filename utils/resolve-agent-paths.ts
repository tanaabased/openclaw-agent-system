import { lstat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

import type { AgentManifest, ManifestDiagnostic } from './manifest-types.ts';

export type AgentPathSource =
  'workspace.bin' | `environment.path-prepend[${number}]` | 'agent-system.bin';

export interface AgentPathEntry {
  path: string;
  source: AgentPathSource;
}

export interface AgentPathProjection {
  entries: AgentPathEntry[];
  path: string;
}

export type AgentPathResolution =
  | { status: 'invalid'; diagnostics: ManifestDiagnostic[] }
  | { status: 'resolved'; projection: AgentPathProjection };

export interface ResolveAgentPathsOptions {
  basePath: string;
  packageDir: string;
  workspaceDir: string;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function inspectDirectory(
  path: string,
  fieldPath: string,
): Promise<{ path?: string; diagnostic?: ManifestDiagnostic }> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) {
      return {
        diagnostic: {
          code: 'path-not-real-directory',
          fieldPath,
          message: `Executable path ${path} must be a real directory and may not be a symbolic link.`,
          severity: 'error',
        },
      };
    }
    return { path: await realpath(path) };
  } catch {
    return {
      diagnostic: {
        code: 'path-directory-unavailable',
        fieldPath,
        message: `Executable path ${path} is missing or unreadable.`,
        severity: 'error',
      },
    };
  }
}

/** Resolve the supported agent command path without evaluating shell syntax. */
export default async function resolveAgentPaths(
  manifest: AgentManifest,
  options: ResolveAgentPathsOptions,
): Promise<AgentPathResolution> {
  const diagnostics: ManifestDiagnostic[] = [];
  const workspaceDir = await realpath(resolve(options.workspaceDir)).catch(() => undefined);
  if (!workspaceDir) {
    return {
      status: 'invalid',
      diagnostics: [
        {
          code: 'path-workspace-unavailable',
          message: 'The agent workspace is missing or unreadable.',
          severity: 'error',
        },
      ],
    };
  }

  const candidates: Array<{ fieldPath: string; path: string; source: AgentPathSource }> = [
    {
      fieldPath: '/environment/path-prepend',
      path: join(workspaceDir, 'bin'),
      source: 'workspace.bin',
    },
    ...(manifest.environment?.pathPrepend ?? []).map((path, index) => ({
      fieldPath: `/environment/path-prepend/${index}`,
      path: resolve(workspaceDir, path),
      source: `environment.path-prepend[${index}]` as const,
    })),
    {
      fieldPath: '/agent-system/bin',
      path: join(resolve(options.packageDir), 'bin'),
      source: 'agent-system.bin',
    },
  ];
  const entries: AgentPathEntry[] = [];
  const seen = new Set<string>();
  const ownedPathAliases = new Set(candidates.map((candidate) => resolve(candidate.path)));
  for (const candidate of candidates) {
    if (candidate.path.includes(delimiter)) {
      diagnostics.push({
        code: 'path-delimiter-unsupported',
        fieldPath: candidate.fieldPath,
        message: `Executable path ${candidate.path} contains the platform PATH delimiter.`,
        severity: 'error',
      });
      continue;
    }
    const inspected = await inspectDirectory(candidate.path, candidate.fieldPath);
    if (inspected.diagnostic) {
      diagnostics.push(inspected.diagnostic);
      continue;
    }
    const canonicalPath = inspected.path;
    if (!canonicalPath) continue;
    if (candidate.source !== 'agent-system.bin' && !isInside(workspaceDir, canonicalPath)) {
      diagnostics.push({
        code: 'path-workspace-escape',
        fieldPath: candidate.fieldPath,
        message: `Executable path ${candidate.path} escapes the agent workspace.`,
        severity: 'error',
      });
      continue;
    }
    if (!seen.has(canonicalPath)) {
      seen.add(canonicalPath);
      ownedPathAliases.add(canonicalPath);
      entries.push({ path: canonicalPath, source: candidate.source });
    }
  }
  const basePath = options.basePath;
  if (
    !basePath.trim() ||
    basePath.includes('\0') ||
    basePath.includes('\n') ||
    basePath.includes('\r')
  ) {
    diagnostics.push({
      code: 'path-base-invalid',
      message: 'The install process does not have a usable base PATH.',
      severity: 'error',
    });
  }
  if (diagnostics.length > 0) return { status: 'invalid', diagnostics };

  const baseEntries: string[] = [];
  for (const path of basePath.split(delimiter)) {
    if (!path) continue;
    const comparablePath = await realpath(resolve(path)).catch(() => resolve(path));
    if (!ownedPathAliases.has(comparablePath)) baseEntries.push(path);
  }
  return {
    status: 'resolved',
    projection: {
      entries,
      path: [...entries.map(({ path }) => path), ...baseEntries].join(delimiter),
    },
  };
}
