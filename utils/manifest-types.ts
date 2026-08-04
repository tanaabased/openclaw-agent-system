export interface AgentManifest {
  schemaVersion: 1;
  agent: {
    id: string;
    name?: string;
    description?: string;
    avatar?: string;
  };
}

export interface ManifestDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  fieldPath?: string;
}

export type ParsedAgentManifest =
  | {
      status: 'invalid';
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'valid';
      manifest: AgentManifest;
      diagnostics: ManifestDiagnostic[];
    };
