import type AgentManifestService from '../lib/agent-manifest-service.ts';
import {
  type CliOutput,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/cli-output.ts';

export interface ValidateAgentSystemOptions {
  agentId?: string;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
  workspaceDir: string;
}

/** Discover and validate one workspace manifest without mutating OpenClaw state. */
export default async function validateAgentSystem(
  options: ValidateAgentSystemOptions,
): Promise<void> {
  const result = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForWorkspace(options.workspaceDir, undefined, 'cli');

  if (result.status !== 'loaded') {
    reportManifestFailure(result, options.output);
    options.setExitCode(1);
    return;
  }

  options.output.write(
    `valid: Agent System manifest for ${result.manifest.agent.id} at ${result.path}\n`,
  );
  reportManifestDiagnostics(result, options.output);
}
