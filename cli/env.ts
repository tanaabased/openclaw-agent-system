import type AgentEnvironmentService from '../lib/agent-environment-service.ts';
import {
  type CliOutput,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/cli-output.ts';
import type { AgentEnvironmentVariable } from '../utils/resolve-agent-environment.ts';

export interface EnvAgentSystemOptions {
  agentId?: string;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId' | 'loadForWorkspace'>;
  json: boolean;
  output: CliOutput;
  setExitCode(code: number): void;
  workspaceDir: string;
}

interface EnvironmentView {
  agentId: string;
  manifestPath: string;
  variables: AgentEnvironmentVariable[];
  workspaceDir: string;
}

function writeJson(output: CliOutput, value: unknown): void {
  output.write(`${JSON.stringify(value, undefined, 2)}\n`);
}

function writeHuman(output: CliOutput, view: EnvironmentView): void {
  output.write(`Agent System environment for ${view.agentId}\n`);
  output.write(`manifest: ${view.manifestPath}\n`);
  if (view.variables.length === 0) {
    output.write('variables: none\n');
    return;
  }
  for (const variable of view.variables) {
    output.write(
      `${variable.name} source=${variable.source} required=${variable.required} overridden=${variable.overriddenSources.length}\n`,
    );
  }
}

/** Inspect Agent System environment metadata without exposing values. */
export default async function envAgentSystem(options: EnvAgentSystemOptions): Promise<void> {
  const result = options.agentId
    ? await options.environmentService.loadForAgentId(options.agentId, 'cli')
    : await options.environmentService.loadForWorkspace(options.workspaceDir, undefined, 'cli');

  if (result.status !== 'loaded') {
    reportManifestFailure(result, options.output);
    options.setExitCode(1);
    return;
  }

  reportManifestDiagnostics(result, options.output);
  const view: EnvironmentView = {
    agentId: result.manifest.agent.id,
    manifestPath: result.path,
    variables: result.environment.variables,
    workspaceDir: result.scope.workspaceDir,
  };
  if (options.json) writeJson(options.output, view);
  else writeHuman(options.output, view);
}
