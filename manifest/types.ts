import type { AgentAutomation, ResolvedAutomation } from './automation-schema.ts';
import type { ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import type { EnvironmentSetValue, ResolvableString } from './value-types.ts';
import type { GoogleConfiguration } from '../tools/google/config-schema.ts';
import type { GitManifestConfiguration } from '../tools/git/config-schema.ts';
import type { GitHubManifestConfiguration } from './github-schema.ts';
import type { AgentSetupConfiguration } from './setup-schema.ts';
import type { AgentModelsConfiguration } from './models-schema.ts';
import type { AgentMemoryConfiguration } from './memory-schema.ts';
import type { BackupConfiguration } from './backup-schema.ts';

export interface AgentManifest {
  schemaVersion: 1;
  automations?: ResolvedAutomation[];
  agent: {
    id: string;
    name?: ResolvableString;
    email?: ResolvableString;
    description?: string;
    avatar?: string;
    emoji?: string;
    runtime?: 'codex';
  };
  environment?: {
    dotenv?: string[];
    op?: string[];
    pathPrepend?: string[];
    required?: string[];
    set?: Record<string, EnvironmentSetValue>;
  };
  google?: GoogleConfiguration;
  git?: GitManifestConfiguration;
  github?: GitHubManifestConfiguration;
  memory?: AgentMemoryConfiguration;
  models?: AgentModelsConfiguration;
  setupHost?: AgentSetupConfiguration;
  setup?: AgentSetupConfiguration;
  backup?: BackupConfiguration;
}

export interface ManifestDiagnostic {
  providerDiagnostic?: ProviderDiagnostic;
  code: string;
  component?: string;
  message: string;
  severity: 'error' | 'warning';
  fieldPath?: string;
  sourcePath?: string;
}

export type ParsedAgentManifest =
  | {
      status: 'invalid';
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'valid';
      manifest: AgentManifest;
      automations?: AgentAutomation[];
      automationsFile?: string;
      setupHostFile?: string;
      setupFile?: string;
      setupFileFieldPath?: '/setup' | '/setup-agent';
      diagnostics: ManifestDiagnostic[];
    };
