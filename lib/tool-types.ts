import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import type { Static, TSchema } from 'typebox';

import type { AgentManifest } from '../utils/manifest-types.ts';
import type { ResolvableString } from '../utils/manifest-value-types.ts';
import type AgentSystemToolRuntime from './tool-runtime.ts';

export type AgentSystemRisk = 'read' | 'write' | 'destructive' | 'admin' | 'unknown';

export interface AgentSystemOperation {
  action: string;
  risk: AgentSystemRisk;
  summary: string;
  resources?: Array<{ type: string; id: string }>;
  attributes?: Record<string, string | number | boolean>;
}

export interface AgentSystemToolGuidance {
  prompt: string;
  skillPath?: string;
}

export interface AgentSystemToolCommand {
  command: string;
}

export interface AgentSystemManifestValueResolver {
  resolve(value: ResolvableString, fieldPath: string): string;
}

export interface AgentSystemCliResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface AgentSystemCliRunRequest {
  argv: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  executable: string;
  excludedExecutableDirectories?: string[];
  maxOutputBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface AgentSystemToolScope {
  source: 'command' | 'tool';
  agentId?: string;
  toolContext?: OpenClawPluginToolContext;
  workspaceDir?: string;
}

export interface AgentSystemAuthorizationRequest {
  agentId: string;
  operation: AgentSystemOperation;
  toolId: string;
  toolName: string;
}

export type AgentSystemAuthorizationDecision =
  { status: 'allowed'; approvalId?: string } | { status: 'denied'; reason: string };

export interface AgentSystemAuditEvent {
  action: string;
  agentId: string;
  auditId: string;
  durationMs?: number;
  inputHash: string;
  phase: 'pending' | 'completed' | 'failed';
  toolId: string;
  risk: AgentSystemRisk;
  source: AgentSystemToolScope['source'];
  status?: string;
  toolName: string;
  truncated?: boolean;
}

export interface AgentSystemCliToolDefinition<
  TParameters extends TSchema,
  TDeclaredConfiguration,
  TResolvedConfiguration,
  TOutput,
> {
  apiVersion: 1;
  id: string;
  configuration: {
    read(manifest: AgentManifest): TDeclaredConfiguration | undefined;
    resolve(
      configuration: TDeclaredConfiguration,
      resolver: AgentSystemManifestValueResolver,
    ): TResolvedConfiguration;
  };
  commands?: AgentSystemToolCommand[];
  guidance?: AgentSystemToolGuidance;
  runner: {
    argv(input: Static<TParameters>, configuration: TResolvedConfiguration): string[];
    credentialBindings?(configuration: TResolvedConfiguration): Record<string, string>;
    environment?(
      configuration: TResolvedConfiguration,
      scope: { agentId: string; workspaceDir: string },
    ): Record<string, string>;
    executable: string;
    maxOutputBytes?: number;
    timeoutMs?: number;
  };
  tool: {
    classify(
      input: Static<TParameters>,
      configuration: TDeclaredConfiguration,
    ): AgentSystemOperation;
    description: string;
    inputFromCommand(argv: string[]): Static<TParameters>;
    label: string;
    name: string;
    normalize(result: AgentSystemCliResult, configuration: TResolvedConfiguration): TOutput;
    parameters: TParameters;
    validate?(input: Static<TParameters>, configuration: TDeclaredConfiguration): void;
  };
}

export interface AgentSystemToolExecutionResult {
  auditId: string;
  operation: AgentSystemOperation;
  output: unknown;
}

export interface RegisteredAgentSystemTool {
  apiVersion: 1;
  commands: readonly AgentSystemToolCommand[];
  guidance?: AgentSystemToolGuidance;
  id: string;
  isConfigured(manifest: AgentManifest): boolean;
  invoke(
    runtime: AgentSystemToolRuntime,
    argv: string[],
    scope: AgentSystemToolScope,
  ): Promise<AgentSystemToolExecutionResult>;
  registerTools(
    api: Pick<OpenClawPluginApi, 'registerTool'>,
    runtime: AgentSystemToolRuntime,
  ): void;
  toolNames: readonly string[];
}
