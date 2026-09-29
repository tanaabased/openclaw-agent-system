import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import loadAutomations from './automation-files.ts';
import readManifestFile, { type ManifestFileDependency } from './read-file.ts';
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
      [...discovery.diagnostics, ...parsed.diagnostics, ...includedHost.diagnostics],
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
      [...discovery.diagnostics, ...parsed.diagnostics, ...included.diagnostics],
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
        [...discovery.diagnostics, ...parsed.diagnostics, ...automationResult.diagnostics],
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
  const digestHash = createHash('sha256').update(contents);
  if (includedHost) digestHash.update('\0').update(includedHost.contents);
  if (included) digestHash.update('\0').update(included.contents);
  for (const file of automationResult.files) digestHash.update('\0').update(file.fingerprint);
  const digest = digestHash.digest('hex').slice(0, 12);

  const lifecycleValidation = options.validateManifest?.(manifest, discovery.workspaceDir) ?? {
    checks: [],
    diagnostics: [],
  };
  const lifecycleDiagnostics = lifecycleValidation.diagnostics;
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
