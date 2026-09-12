import type { ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import type { EnvironmentSetValue, ResolvableString } from './value-types.ts';
import type { GitManifestConfiguration } from '../tools/git/config-schema.ts';
import type { GitHubManifestConfiguration } from './github-schema.ts';
import type { AgentModelsConfiguration } from './models-schema.ts';

export interface AgentManifest {
  schemaVersion: 1;
  agent: {
    id: string;
    name?: ResolvableString;
    email?: ResolvableString;
    description?: string;
    avatar?: string;
    emoji?: string;
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
  models?: AgentModelsConfiguration;
}

export interface ManifestDiagnostic {
  providerDiagnostic?: ProviderDiagnostic;
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
