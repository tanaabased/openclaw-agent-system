import loadCommandManifest from './load-command-manifest.ts';
import type AgentDoctorService from '../agent/doctor-service.ts';
import type AgentManifestService from '../manifest/service.ts';
import { type CliOutput, type CliStyles, writeCliJson, writeCliLifecycleTable } from './output.ts';
import { lifecycleTableLines, orderDoctorFindings } from '../core/lifecycle-presentation.ts';

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
  const manifest = await loadCommandManifest(options);
  if (!manifest) return;
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
