import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { maximumManifestBytes, type ManifestDiscovery } from './discover.ts';
import parseAgentManifest from './parse.ts';
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
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'loaded';
      scope: AgentManifestScope;
      path: string;
      digest: string;
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
): Extract<AgentManifestLoadResult, { status: 'invalid' }> {
  return {
    status: 'invalid',
    scope,
    ...(path === undefined ? {} : { path }),
    diagnostics,
  };
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

  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 12);
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

  const lifecycleValidation = options.validateManifest?.(
    parsed.manifest,
    discovery.workspaceDir,
  ) ?? { checks: [], diagnostics: [] };
  const lifecycleDiagnostics = lifecycleValidation.diagnostics;
  if (lifecycleDiagnostics.some(({ severity }) => severity === 'error')) {
    return invalidManifestResult(
      scope,
      [...discovery.diagnostics, ...parsed.diagnostics, ...lifecycleDiagnostics],
      selected.path,
    );
  }

  return {
    status: 'loaded',
    scope,
    path: selected.path,
    digest,
    manifest: parsed.manifest,
    diagnostics: [...discovery.diagnostics, ...parsed.diagnostics, ...lifecycleDiagnostics],
    validationChecks: lifecycleValidation.checks,
  };
}
