import type AgentManifestService from '../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnosticNotices,
  writeCliJson,
  writeCliSummary,
} from './output.ts';
import lifecyclePresentationLines from '../core/lifecycle-presentation.ts';
import { formatManifestDiagnostics, formatManifestFailure } from '../core/logger.ts';

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
    writeCliDiagnosticNotices(
      options,
      formatManifestFailure(result).map(({ level, message }) => ({ severity: level, message })),
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
  writeCliDiagnosticNotices(
    options,
    formatManifestDiagnostics(result).map(({ level, message }) => ({ severity: level, message })),
  );
}
