import type { ResolvableString } from './manifest-value-types.ts';

export interface AgentManifest {
  schemaVersion: 1;
  agent: {
    id: string;
    name?: ResolvableString;
    email?: ResolvableString;
    description?: string;
    avatar?: string;
  };
  environment?: {
    dotenv?: string[];
    op?: string[];
    pathPrepend?: string[];
    required?: string[];
    set?: Record<string, string>;
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
