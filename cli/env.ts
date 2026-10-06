import presentCliCommand from './presentation.ts';
import type AgentEnvironmentService from '../environment/service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnosticNotices,
  writeCliJson,
  writeCliSummary,
} from './output.ts';
import { formatManifestDiagnostics, formatManifestFailure } from '../core/logger.ts';
import type { AgentEnvironmentVariable } from '../environment/resolve.ts';

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
async function envAgentSystem(options: EnvAgentSystemOptions): Promise<void> {
  const result = options.agentId
    ? await options.environmentService.loadForAgentId(options.agentId, 'cli')
    : await options.environmentService.loadForCommandDirectory(options.workspaceDir, 'cli');

  if (result.status !== 'loaded') {
    writeCliDiagnosticNotices(
      options,
      formatManifestFailure(result).map(({ level, message }) => ({ severity: level, message })),
    );
    options.setExitCode(1);
    return;
  }

  writeCliDiagnosticNotices(
    options,
    formatManifestDiagnostics(result).map(({ level, message }) => ({ severity: level, message })),
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

export default presentCliCommand(envAgentSystem);
