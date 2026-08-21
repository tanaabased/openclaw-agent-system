import type AgentEnvironmentService from '../lib/agent-environment-service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnostics,
  writeCliJson,
  writeCliSummary,
} from '../lib/cli-output.ts';
import { formatManifestDiagnostics, formatManifestFailure } from '../lib/logger.ts';
import type { AgentEnvironmentVariable } from '../utils/resolve-agent-environment.ts';

export interface EnvAgentSystemOptions {
  agentId?: string;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  json: boolean;
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
    : await options.environmentService.loadForCommandDirectory(options.workspaceDir, 'cli');

  if (result.status !== 'loaded') {
    writeCliDiagnostics(
      options.output,
      formatManifestFailure(result).map(({ message }) => message),
    );
    options.setExitCode(1);
    return;
  }

  writeCliDiagnostics(
    options.output,
    formatManifestDiagnostics(result).map(({ message }) => message),
  );
  const view: EnvironmentView = {
    agentId: result.manifest.agent.id,
    manifestPath: result.path,
    variables: result.environment.variables,
    workspaceDir: result.scope.workspaceDir,
  };
  if (options.json) writeCliJson(options.output, view);
  else writeHuman(options.output, view, options.styles);
}
