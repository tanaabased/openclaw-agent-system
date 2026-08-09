import type AgentManifestService from '../lib/agent-manifest-service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliJson,
  writeCliSummary,
} from '../lib/cli-output.ts';
import lifecyclePresentationLines from '../lib/lifecycle-presentation.ts';
import { type Logger, reportManifestDiagnostics, reportManifestFailure } from '../lib/logger.ts';

export interface ValidateAgentSystemOptions {
  agentId?: string;
  json: boolean;
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

  const checks = [
    {
      code: 'manifest-valid',
      component: 'manifest',
      message: `Agent System manifest for ${result.manifest.agent.id}`,
      status: 'valid' as const,
    },
    ...result.validationChecks,
  ];
  if (options.json) {
    writeCliJson(options.output, {
      agentId: result.manifest.agent.id,
      checks,
      diagnostics: result.diagnostics,
      manifestPath: result.path,
      status: 'valid',
      workspaceDir: result.scope.workspaceDir,
    });
  } else {
    writeCliSummary(
      options.output,
      [
        ...lifecyclePresentationLines(checks),
        {
          label: 'manifest',
          style: 'target',
          value: result.path,
        },
      ],
      options.styles,
    );
  }
  reportManifestDiagnostics(result, options.logger);
}
