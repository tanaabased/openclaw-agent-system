import type AgentManifestService from '../lib/agent-manifest-service.ts';
import { type CliOutput, type CliStyles, writeCliSummary } from '../lib/cli-output.ts';
import { type Logger, reportManifestDiagnostics, reportManifestFailure } from '../lib/logger.ts';

export interface ValidateAgentSystemOptions {
  agentId?: string;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
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
    reportManifestFailure(result, options.logger);
    options.setExitCode(1);
    return;
  }

  writeCliSummary(
    options.output,
    [
      {
        label: 'valid',
        style: 'status',
        value: `Agent System manifest for ${result.manifest.agent.id}`,
      },
      { label: 'manifest', style: 'target', value: result.path },
    ],
    options.styles,
  );
  reportManifestDiagnostics(result, options.logger);
}
