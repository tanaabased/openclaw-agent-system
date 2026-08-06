import type AgentEnvironmentService from '../lib/agent-environment-service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliJson,
  writeCliSummary,
} from '../lib/cli-output.ts';
import { type Logger, reportManifestDiagnostics, reportManifestFailure } from '../lib/logger.ts';
import type { AgentEnvironmentVariable } from '../utils/resolve-agent-environment.ts';

export interface EnvAgentSystemOptions {
  agentId?: string;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId' | 'loadForWorkspace'>;
  json: boolean;
  logger: Logger;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
  workspaceDir: string;
}

interface EnvironmentView {
  agentId: string;
  manifestPath: string;
  variables: AgentEnvironmentVariable[];
  workspaceDir: string;
}

function writeHuman(output: CliOutput, view: EnvironmentView, styles?: CliStyles): void {
  writeCliSummary(
    output,
    [
      { label: 'environment', style: 'target', value: view.agentId },
      { label: 'manifest', style: 'target', value: view.manifestPath },
      ...(view.variables.length === 0
        ? [{ label: 'variables', style: 'field' as const, value: 'none' }]
        : view.variables.map((variable) => ({
            label: variable.name,
            style: 'field' as const,
            value: `source=${variable.source} required=${variable.required} overridden=${variable.overriddenSources.length}`,
          }))),
    ],
    styles,
  );
}

/** Inspect Agent System environment metadata without exposing values. */
export default async function envAgentSystem(options: EnvAgentSystemOptions): Promise<void> {
  const result = options.agentId
    ? await options.environmentService.loadForAgentId(options.agentId, 'cli')
    : await options.environmentService.loadForWorkspace(options.workspaceDir, undefined, 'cli');

  if (result.status !== 'loaded') {
    reportManifestFailure(result, options.logger);
    options.setExitCode(1);
    return;
  }

  reportManifestDiagnostics(result, options.logger);
  const view: EnvironmentView = {
    agentId: result.manifest.agent.id,
    manifestPath: result.path,
    variables: result.environment.variables,
    workspaceDir: result.scope.workspaceDir,
  };
  if (options.json) writeCliJson(options.output, view);
  else writeHuman(options.output, view, options.styles);
}
