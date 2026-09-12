import type AgentDoctorService from '../agent/doctor-service.ts';
import type AgentManifestService from '../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnostics,
  writeCliJson,
  writeCliLifecycleTable,
} from './output.ts';
import { lifecycleTableLines, orderDoctorFindings } from '../core/lifecycle-presentation.ts';
import { formatManifestDiagnostics, formatManifestFailure } from '../core/logger.ts';

export interface DoctorAgentSystemOptions {
  agentId?: string;
  doctorService: Pick<AgentDoctorService, 'inspect'>;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
  terminalColumns?: number;
  workspaceDir: string;
}

/** Inspect every configured Agent System lifecycle component without applying repairs. */
export default async function doctorAgentSystem(options: DoctorAgentSystemOptions): Promise<void> {
  const manifest = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  if (manifest.status !== 'loaded') {
    writeCliDiagnostics(
      options.output,
      formatManifestFailure(manifest).map(({ message }) => message),
    );
    options.setExitCode(1);
    return;
  }
  writeCliDiagnostics(
    options.output,
    formatManifestDiagnostics(manifest).map(({ message }) => message),
  );
  const result = await options.doctorService.inspect({
    manifest: manifest.manifest,
    workspaceDir: manifest.scope.workspaceDir,
  });
  if (options.json) writeCliJson(options.output, result);
  else {
    writeCliLifecycleTable(
      options.output,
      lifecycleTableLines(
        orderDoctorFindings(result.findings).map((finding) => ({
          component: finding.component,
          message: `${finding.message}${finding.remediation ? ` ${finding.remediation}` : ''}`,
          status: finding.status,
        })),
      ),
      result.workspaceDir,
      options.styles,
      options.terminalColumns,
    );
  }
  if (result.status !== 'healthy') options.setExitCode(1);
}
