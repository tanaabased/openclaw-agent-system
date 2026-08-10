import type { EnvironmentSetValue, ResolvableString } from './manifest-value-types.ts';
import type { GitManifestConfiguration } from '../tools/git/config-schema.ts';
import type { GitHubManifestConfiguration } from '../tools/github/config-schema.ts';

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
    set?: Record<string, EnvironmentSetValue>;
  };
  git?: GitManifestConfiguration;
  github?: GitHubManifestConfiguration;
}

export interface ManifestDiagnostic {
  code: string;
  component?: string;
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
