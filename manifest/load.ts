import { createHash } from 'node:crypto';

import loadAutomations from './automation-files.ts';
import readManifestFile, { type ManifestFileDependency } from './read-file.ts';
import type { ManifestDiscovery } from './discover.ts';
import { normalizeAgentManifest, parseManifestYaml } from './parse.ts';
import mergeManifestDocuments, {
  manifestSourceForField,
  type ManifestSources,
} from './merge-documents.ts';
import readManifestDocument from './read-document.ts';
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
      automationFilePaths?: string[];
      setupHostFilePath?: string;
      setupFilePath?: string;
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'loaded';
      scope: AgentManifestScope;
      path: string;
      digest: string;
      overlayPath?: string;
      /** effective YAML pointers to declarations; normalized defaults have no source field. */
      sources?: ManifestSources;
      setupHostFilePath?: string;
      setupHostFileFingerprint?: string;
      setupFilePath?: string;
      setupFileFingerprint?: string;
      automationFiles?: ManifestFileDependency[];
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
  setupHostFilePath?: string,
): Extract<AgentManifestLoadResult, { status: 'invalid' }> {
  return {
    status: 'invalid',
    scope,
    ...(path === undefined ? {} : { path }),
    ...(setupFilePath === undefined ? {} : { setupFilePath }),
    ...(setupHostFilePath === undefined ? {} : { setupHostFilePath }),
    diagnostics,
  };
}

async function loadSetupFile(
  reference: string,
  manifestPath: string,
  workspaceDir: string,
  fieldPath = '/setup',
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
  const loaded = await readManifestFile(
    reference,
    manifestPath,
    workspaceDir,
    fieldPath,
    'manifest-setup-file',
  );
  if (loaded.status === 'invalid') return loaded;
  const { path, fingerprint, contents, source } = loaded;
  const yaml = parseManifestYaml(source);
  if (yaml.status === 'invalid') {
    return {
      status: 'invalid',
      path,
      diagnostics: yaml.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        fieldPath,
        sourcePath: path,
        message: `Setup file ${JSON.stringify(reference)} contains invalid YAML (${diagnostic.code}).`,
      })),
    };
  }
  const normalized = normalizeAgentSetup(yaml.value, fieldPath);
  if (normalized.status === 'invalid') {
    return {
      status: 'invalid',
      path,
      diagnostics: normalized.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        sourcePath: path,
        message: `Setup file ${JSON.stringify(reference)}: ${diagnostic.message}`,
      })),
    };
  }
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
  if (selected.status === 'invalid' || discovery.overlay?.status === 'invalid') {
    return invalidManifestResult(scope, discovery.diagnostics, selected.path);
  }

  const base = await readManifestDocument(selected.path);
  if (base.status === 'invalid')
    return invalidManifestResult(
      scope,
      [...discovery.diagnostics, ...base.diagnostics],
      selected.path,
    );
  const overlay =
    discovery.overlay?.status === 'readable'
      ? await readManifestDocument(discovery.overlay.path)
      : undefined;
  if (overlay?.status === 'invalid')
    return invalidManifestResult(
      scope,
      [...discovery.diagnostics, ...overlay.diagnostics],
      selected.path,
    );
  const { value, sources } = mergeManifestDocuments(base, overlay);
  const parsed = normalizeAgentManifest(value);
  const attributeDiagnostics = (diagnostics: ManifestDiagnostic[]): ManifestDiagnostic[] =>
    diagnostics.map((diagnostic) => ({
      ...diagnostic,
      ...(diagnostic.fieldPath === undefined || diagnostic.sourcePath !== undefined
        ? {}
        : {
            sourcePath: manifestSourceForField(sources, diagnostic.fieldPath)?.path,
          }),
    }));
  parsed.diagnostics = attributeDiagnostics(parsed.diagnostics);
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
          sourcePath: sources['/agent/id']?.path,
          message: `Manifest agent id ${parsed.manifest.agent.id} does not match OpenClaw agent ${expectedAgentId}.`,
          severity: 'error',
        },
      ],
      selected.path,
    );
  }

  const includedHost = parsed.setupHostFile
    ? await loadSetupFile(
        parsed.setupHostFile,
        selected.path,
        discovery.workspaceDir,
        '/setup-host',
      )
    : undefined;
  if (includedHost?.status === 'invalid') {
    return invalidManifestResult(
      scope,
      [
        ...discovery.diagnostics,
        ...parsed.diagnostics,
        ...attributeDiagnostics(includedHost.diagnostics),
      ],
      selected.path,
      undefined,
      includedHost.path,
    );
  }
  const included = parsed.setupFile
    ? await loadSetupFile(
        parsed.setupFile,
        selected.path,
        discovery.workspaceDir,
        parsed.setupFileFieldPath,
      )
    : undefined;
  if (included?.status === 'invalid') {
    return invalidManifestResult(
      scope,
      [
        ...discovery.diagnostics,
        ...parsed.diagnostics,
        ...attributeDiagnostics(included.diagnostics),
      ],
      selected.path,
      included.path,
      includedHost?.path,
    );
  }
  const automationResult = await loadAutomations(parsed, selected.path, discovery.workspaceDir);
  if (automationResult.status === 'invalid')
    return {
      ...invalidManifestResult(
        scope,
        [
          ...discovery.diagnostics,
          ...parsed.diagnostics,
          ...attributeDiagnostics(automationResult.diagnostics),
        ],
        selected.path,
        included?.path,
        includedHost?.path,
      ),
      automationFilePaths: automationResult.paths,
    };
  const manifest: AgentManifest = {
    ...parsed.manifest,
    ...(parsed.automations !== undefined || parsed.automationsFile !== undefined
      ? { automations: automationResult.automations }
      : {}),
    ...(includedHost ? { setupHost: includedHost.setup } : {}),
    ...(included ? { setup: included.setup } : {}),
  };
  const digestHash = createHash('sha256').update(base.contents);
  if (overlay) digestHash.update('\0agent.local.yaml\0').update(overlay.contents);
  if (includedHost) digestHash.update('\0').update(includedHost.contents);
  if (included) digestHash.update('\0').update(included.contents);
  for (const file of automationResult.files) digestHash.update('\0').update(file.fingerprint);
  const digest = digestHash.digest('hex').slice(0, 12);

  const lifecycleValidation = options.validateManifest?.(manifest, discovery.workspaceDir) ?? {
    checks: [],
    diagnostics: [],
  };
  const lifecycleDiagnostics = attributeDiagnostics(lifecycleValidation.diagnostics);
  if (lifecycleDiagnostics.some(({ severity }) => severity === 'error')) {
    return {
      ...invalidManifestResult(
        scope,
        [...discovery.diagnostics, ...parsed.diagnostics, ...lifecycleDiagnostics],
        selected.path,
        included?.path,
        includedHost?.path,
      ),
      automationFilePaths: automationResult.files.map((file) => file.path),
    };
  }

  return {
    status: 'loaded',
    scope,
    path: selected.path,
    digest,
    sources,
    ...(overlay ? { overlayPath: overlay.path } : {}),
    ...(includedHost === undefined
      ? {}
      : {
          setupHostFilePath: includedHost.path,
          setupHostFileFingerprint: includedHost.fingerprint,
        }),
    ...(included === undefined
      ? {}
      : { setupFilePath: included.path, setupFileFingerprint: included.fingerprint }),
    manifest,
    ...(automationResult.files.length ? { automationFiles: automationResult.files } : {}),
    diagnostics: [...discovery.diagnostics, ...parsed.diagnostics, ...lifecycleDiagnostics],
    validationChecks: lifecycleValidation.checks,
  };
}
