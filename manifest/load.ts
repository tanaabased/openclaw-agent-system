import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { maximumManifestBytes, type ManifestDiscovery } from './discover.ts';
import parseAgentManifest, { parseManifestYaml } from './parse.ts';
import { normalizeAgentSetup } from './setup-schema.ts';
import type { AgentManifest, ManifestDiagnostic } from './types.ts';

export interface AgentManifestValidationCheck {
  code: string;
  component: string;
  message: string;
  status: 'valid';
}

export interface AgentManifestScope {
  agentId?: string;
  workspaceDir: string;
}

export type AgentManifestLoadResult =
  | { status: 'unresolved'; diagnostics: ManifestDiagnostic[] }
  | { status: 'unmanaged'; scope: AgentManifestScope; diagnostics: ManifestDiagnostic[] }
  | {
      status: 'invalid';
      scope: AgentManifestScope;
      path?: string;
      setupFilePath?: string;
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'loaded';
      scope: AgentManifestScope;
      path: string;
      digest: string;
      setupFilePath?: string;
      setupFileFingerprint?: string;
      manifest: AgentManifest;
      diagnostics: ManifestDiagnostic[];
      validationChecks: AgentManifestValidationCheck[];
    };

export type DiscoveredAgentManifestLoadResult = Exclude<
  AgentManifestLoadResult,
  { status: 'unresolved' }
>;

export interface DiscoveredManifestLoadOptions {
  expectedAgentId?: string;
  validateManifest?(
    manifest: AgentManifest,
    workspaceDir: string,
  ): {
    checks: AgentManifestValidationCheck[];
    diagnostics: ManifestDiagnostic[];
  };
}

export function invalidManifestResult(
  scope: AgentManifestScope,
  diagnostics: ManifestDiagnostic[],
  path?: string,
  setupFilePath?: string,
): Extract<AgentManifestLoadResult, { status: 'invalid' }> {
  return {
    status: 'invalid',
    scope,
    ...(path === undefined ? {} : { path }),
    ...(setupFilePath === undefined ? {} : { setupFilePath }),
    diagnostics,
  };
}

function setupFileDiagnostic(code: string, reference: string, detail: string): ManifestDiagnostic {
  return {
    code,
    fieldPath: '/setup/file',
    message: `Setup file ${JSON.stringify(reference)} ${detail}`,
    severity: 'error',
  };
}

function withinWorkspace(workspace: string, path: string): boolean {
  const remainder = relative(workspace, path);
  return remainder !== '..' && !remainder.startsWith('../') && !isAbsolute(remainder);
}

async function loadSetupFile(
  reference: string,
  manifestPath: string,
  workspaceDir: string,
): Promise<
  | {
      status: 'valid';
      path: string;
      fingerprint: string;
      contents: Buffer;
      setup: NonNullable<AgentManifest['setup']>;
    }
  | { status: 'invalid'; path?: string; diagnostics: ManifestDiagnostic[] }
> {
  if (
    isAbsolute(reference) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(reference) ||
    reference.includes('\\') ||
    reference.includes('\0')
  ) {
    return {
      status: 'invalid',
      diagnostics: [
        setupFileDiagnostic(
          'manifest-setup-file-path',
          reference,
          'must be a local relative path.',
        ),
      ],
    };
  }
  const path = resolve(dirname(manifestPath), reference);
  if (!withinWorkspace(workspaceDir, path)) {
    return {
      status: 'invalid',
      diagnostics: [
        setupFileDiagnostic(
          'manifest-setup-file-escape',
          reference,
          'escapes the agent workspace.',
        ),
      ],
    };
  }

  let canonicalPath: string;
  try {
    const [canonicalWorkspace, resolvedFile] = await Promise.all([
      realpath(workspaceDir),
      realpath(path),
    ]);
    if (!withinWorkspace(canonicalWorkspace, resolvedFile)) {
      return {
        status: 'invalid',
        path,
        diagnostics: [
          setupFileDiagnostic(
            'manifest-setup-file-escape',
            reference,
            'escapes the agent workspace through a symlink.',
          ),
        ],
      };
    }
    canonicalPath = resolvedFile;
    if (!(await stat(canonicalPath)).isFile()) {
      return {
        status: 'invalid',
        path,
        diagnostics: [
          setupFileDiagnostic(
            'manifest-setup-file-not-regular',
            reference,
            'must name a regular file.',
          ),
        ],
      };
    }
  } catch (error) {
    return {
      status: 'invalid',
      path,
      diagnostics: [
        setupFileDiagnostic(
          'manifest-setup-file-unreadable',
          reference,
          `could not be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`,
        ),
      ],
    };
  }

  let contents: Buffer;
  try {
    contents = await readFile(canonicalPath);
  } catch (error) {
    return {
      status: 'invalid',
      path,
      diagnostics: [
        setupFileDiagnostic(
          'manifest-setup-file-unreadable',
          reference,
          `could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`,
        ),
      ],
    };
  }
  if (contents.byteLength > maximumManifestBytes) {
    return {
      status: 'invalid',
      path,
      diagnostics: [
        setupFileDiagnostic(
          'manifest-setup-file-too-large',
          reference,
          `exceeds the ${maximumManifestBytes}-byte size limit.`,
        ),
      ],
    };
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    return {
      status: 'invalid',
      path,
      diagnostics: [
        setupFileDiagnostic('manifest-setup-file-encoding', reference, 'must be valid UTF-8.'),
      ],
    };
  }
  const yaml = parseManifestYaml(source);
  if (yaml.status === 'invalid') {
    return {
      status: 'invalid',
      path,
      diagnostics: yaml.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        fieldPath: '/setup',
        message: `Setup file ${JSON.stringify(reference)} contains invalid YAML (${diagnostic.code}).`,
      })),
    };
  }
  const normalized = normalizeAgentSetup(yaml.value);
  if (normalized.status === 'invalid') {
    return {
      status: 'invalid',
      path,
      diagnostics: normalized.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: `Setup file ${JSON.stringify(reference)}: ${diagnostic.message}`,
      })),
    };
  }
  const fingerprint = createHash('sha256')
    .update(canonicalPath)
    .update('\0')
    .update(contents)
    .digest('hex');
  return { status: 'valid', path, fingerprint, contents, setup: normalized.setup };
}

/** Load one already discovered manifest without depending on an OpenClaw runtime. */
export async function loadDiscoveredManifest(
  discovery: ManifestDiscovery,
  options: DiscoveredManifestLoadOptions = {},
): Promise<DiscoveredAgentManifestLoadResult> {
  const expectedAgentId = options.expectedAgentId;
  const scope: AgentManifestScope = {
    ...(expectedAgentId === undefined ? {} : { agentId: expectedAgentId }),
    workspaceDir: discovery.workspaceDir,
  };
  const selected = discovery.selected;

  if (!selected) return { status: 'unmanaged', scope, diagnostics: [] };
  if (selected.status === 'invalid') {
    return invalidManifestResult(scope, discovery.diagnostics, selected.path);
  }

  const contents = await readFile(selected.path);
  if (contents.byteLength > maximumManifestBytes) {
    return invalidManifestResult(
      scope,
      [
        ...discovery.diagnostics,
        {
          code: 'manifest-too-large',
          message: `The manifest exceeds the ${maximumManifestBytes}-byte size limit.`,
          severity: 'error',
        },
      ],
      selected.path,
    );
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    return invalidManifestResult(
      scope,
      [
        ...discovery.diagnostics,
        {
          code: 'manifest-encoding',
          message: 'The manifest must be valid UTF-8.',
          severity: 'error',
        },
      ],
      selected.path,
    );
  }

  const parsed = parseAgentManifest(source);
  if (parsed.status === 'invalid') {
    return invalidManifestResult(
      scope,
      [...discovery.diagnostics, ...parsed.diagnostics],
      selected.path,
    );
  }

  if (expectedAgentId && parsed.manifest.agent.id !== expectedAgentId) {
    return invalidManifestResult(
      scope,
      [
        ...discovery.diagnostics,
        {
          code: 'agent-id-mismatch',
          fieldPath: '/agent/id',
          message: `Manifest agent id ${parsed.manifest.agent.id} does not match OpenClaw agent ${expectedAgentId}.`,
          severity: 'error',
        },
      ],
      selected.path,
    );
  }

  const included = parsed.setupFile
    ? await loadSetupFile(parsed.setupFile, selected.path, discovery.workspaceDir)
    : undefined;
  if (included?.status === 'invalid') {
    return invalidManifestResult(
      scope,
      [...discovery.diagnostics, ...parsed.diagnostics, ...included.diagnostics],
      selected.path,
      included.path,
    );
  }
  const manifest = included ? { ...parsed.manifest, setup: included.setup } : parsed.manifest;
  const digestHash = createHash('sha256').update(contents);
  if (included) digestHash.update('\0').update(included.contents);
  const digest = digestHash.digest('hex').slice(0, 12);

  const lifecycleValidation = options.validateManifest?.(manifest, discovery.workspaceDir) ?? {
    checks: [],
    diagnostics: [],
  };
  const lifecycleDiagnostics = lifecycleValidation.diagnostics;
  if (lifecycleDiagnostics.some(({ severity }) => severity === 'error')) {
    return invalidManifestResult(
      scope,
      [...discovery.diagnostics, ...parsed.diagnostics, ...lifecycleDiagnostics],
      selected.path,
      included?.path,
    );
  }

  return {
    status: 'loaded',
    scope,
    path: selected.path,
    digest,
    ...(included === undefined
      ? {}
      : { setupFilePath: included.path, setupFileFingerprint: included.fingerprint }),
    manifest,
    diagnostics: [...discovery.diagnostics, ...parsed.diagnostics, ...lifecycleDiagnostics],
    validationChecks: lifecycleValidation.checks,
  };
}
