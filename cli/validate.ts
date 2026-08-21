import type AgentManifestService from '../lib/agent-manifest-service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnostics,
  writeCliJson,
  writeCliSummary,
} from '../lib/cli-output.ts';
import lifecyclePresentationLines from '../lib/lifecycle-presentation.ts';
import { formatManifestDiagnostics, formatManifestFailure } from '../lib/logger.ts';

export interface ValidateAgentSystemOptions {
  agentId?: string;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
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
    : await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');

  if (result.status !== 'loaded') {
    writeCliDiagnostics(
      options.output,
      formatManifestFailure(result).map(({ message }) => message),
    );
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
  writeCliDiagnostics(
    options.output,
    formatManifestDiagnostics(result).map(({ message }) => message),
  );
}
