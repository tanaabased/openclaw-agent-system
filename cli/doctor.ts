import type AgentDoctorService from '../lib/agent-doctor-service.ts';
import type AgentManifestService from '../lib/agent-manifest-service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliJson,
  writeCliSummary,
} from '../lib/cli-output.ts';
import { type Logger, reportManifestDiagnostics, reportManifestFailure } from '../lib/logger.ts';

export interface DoctorAgentSystemOptions {
  agentId?: string;
  doctorService: Pick<AgentDoctorService, 'inspect'>;
  json: boolean;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
  workspaceDir: string;
}

/** Inspect implemented Agent System drift without applying repairs. */
export default async function doctorAgentSystem(options: DoctorAgentSystemOptions): Promise<void> {
  const manifest = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForWorkspace(options.workspaceDir, undefined, 'cli');
  if (manifest.status !== 'loaded') {
    reportManifestFailure(manifest, options.logger);
    options.setExitCode(1);
    return;
  }
  reportManifestDiagnostics(manifest, options.logger);
  const result = await options.doctorService.inspect({
    manifest: manifest.manifest,
    workspaceDir: manifest.scope.workspaceDir,
  });
  if (options.json) writeCliJson(options.output, result);
  else {
    writeCliSummary(
      options.output,
      [
        ...result.findings.map((finding) => ({
          label: finding.status,
          style:
            finding.status === 'healthy'
              ? ('status' as const)
              : finding.status === 'drift'
                ? ('action' as const)
                : ('field' as const),
          value: `${finding.message}${finding.remediation ? ` ${finding.remediation}` : ''}`,
        })),
        { label: 'workspace', style: 'target' as const, value: result.workspaceDir },
      ],
      options.styles,
    );
  }
  if (result.status === 'drift') options.setExitCode(1);
}
