import type AgentEnvironmentService from '../lib/agent-environment-service.ts';
import type AgentExecProbeService from '../lib/agent-exec-probe-service.ts';
import {
  type CliOutput,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/cli-output.ts';
import type { ObservedExecEnvironmentVariable } from '../utils/exec-env-probe.ts';
import type { AgentEnvironmentVariable } from '../utils/resolve-agent-environment.ts';

export interface EnvAgentSystemOptions {
  agentId?: string;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId' | 'loadForWorkspace'>;
  exec: boolean;
  execProbeService: Pick<AgentExecProbeService, 'probe'>;
  json: boolean;
  output: CliOutput;
  setExitCode(code: number): void;
  workspaceDir: string;
}

interface EnvironmentView {
  agentId: string;
  manifestPath: string;
  variables: Array<AgentEnvironmentVariable | ObservedExecEnvironmentVariable>;
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
    const observed =
      'observedExecDelivery' in variable ? ` observed=${variable.observedExecDelivery}` : '';
    output.write(
      `${variable.name} source=${variable.source} static=${variable.staticExecDelivery}${observed}\n`,
    );
  }
}

/** Inspect Agent System metadata and optionally probe the active Gateway exec filter. */
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
  if (!options.exec) {
    if (options.json) writeJson(options.output, view);
    else writeHuman(options.output, view);
    return;
  }

  const probe = await options.execProbeService.probe(
    result.manifest.agent.id,
    result.environment.variables,
  );
  if (probe.status === 'completed') {
    const observedView = { ...view, variables: probe.variables };
    if (options.json) writeJson(options.output, observedView);
    else writeHuman(options.output, observedView);
    return;
  }

  if (options.json) {
    writeJson(options.output, {
      ...view,
      execProbe:
        probe.status === 'disabled'
          ? {
              ...probe,
              restartRequired: true,
              securityImplication:
                'Authenticated operator clients can invoke shell commands through the Gateway.',
            }
          : probe,
    });
  } else if (probe.status === 'disabled') {
    writeHuman(options.output, view);
    options.output.error(
      'error: [exec-probe-disabled] Gateway direct invocation of exec is not enabled.\n',
    );
    options.output.error(
      'security: enabling it lets authenticated operator clients invoke shell commands through the Gateway. Keep the Gateway private and protect its credentials.\n',
    );
    options.output.error(`enable: ${probe.enableCommand}\n`);
    options.output.error('restart the Gateway after changing this setting, then retry.\n');
  } else {
    writeHuman(options.output, view);
    options.output.error(`error: [${probe.code}] ${probe.message}\n`);
  }
  options.setExitCode(1);
}
