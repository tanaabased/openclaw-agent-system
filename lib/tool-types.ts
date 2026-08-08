import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from 'openclaw/plugin-sdk/plugin-entry';
import type { Static, TSchema } from 'typebox';

import type { AgentManifest } from '../utils/manifest-types.ts';
import type { ResolvableString } from '../utils/manifest-value-types.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type AgentSystemToolApprovalReceiptStore from './tool-approval-receipt-store.ts';
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
}

export interface AgentSystemToolCommand {
  command: string;
}

export interface AgentSystemManifestValueResolver {
  resolve(value: ResolvableString, fieldPath: string): string;
}

export interface AgentSystemCliResult {
  exitCode: number | null;
  resolvedExecutable?: string;
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
  stdin?: string;
  timeoutMs: number;
}

export interface AgentSystemToolScope {
  source: 'command' | 'tool';
  agentId?: string;
  terminalColumns?: number;
  toolCallId?: string;
  toolContext?: OpenClawPluginToolContext;
  workspaceDir?: string;
}

export type AgentSystemCredentialBinding =
  | string
  | {
      anyOf: readonly string[];
    };

export interface AgentSystemAuthorizationRequest {
  agentId: string;
  operation: AgentSystemOperation;
  toolId: string;
  toolName: string;
}

export type AgentSystemAuthorizationDecision =
  | { status: 'allowed'; approvalId?: string }
  | { status: 'denied'; reason: string }
  | {
      status: 'approval_required';
      reason: string;
      request: {
        description: string;
        severity: 'info' | 'warning' | 'critical';
        title: string;
      };
    };

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
  authorization?: {
    authorize?(
      operation: AgentSystemOperation,
      configuration: TDeclaredConfiguration,
    ): AgentSystemAuthorizationDecision | Promise<AgentSystemAuthorizationDecision>;
    mode: 'agent-system' | 'provider';
    policyId?: string;
  };
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
    credentialBindings?(
      configuration: TResolvedConfiguration,
    ): Record<string, AgentSystemCredentialBinding>;
    environment?(
      configuration: TResolvedConfiguration,
      scope: {
        agentId: string;
        source: AgentSystemToolScope['source'];
        terminalColumns?: number;
        workspaceDir: string;
      },
    ): Record<string, string>;
    executable: string;
    maxOutputBytes?: number;
    preflight?(configuration: TResolvedConfiguration):
      | {
          argv: string[];
          validate(result: AgentSystemCliResult): void;
        }
      | undefined;
    prepare?(
      configuration: TResolvedConfiguration,
      scope: { agentId: string; workspaceDir: string },
    ): Promise<void> | void;
    stdin?(input: Static<TParameters>, configuration: TResolvedConfiguration): string | undefined;
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
  commandResult: AgentSystemCliResult;
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
  registerTrustedPolicy?(
    api: Pick<OpenClawPluginApi, 'registerTrustedToolPolicy'>,
    manifestService: Pick<AgentManifestService, 'loadForAgentId'>,
    approvals: Pick<AgentSystemToolApprovalReceiptStore, 'record'>,
  ): void;
  toolNames: readonly string[];
}
