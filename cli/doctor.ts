import presentCliCommand from './presentation.ts';
import loadCommandManifest from './load-command-manifest.ts';
import type AgentDoctorService from '../agent/doctor-service.ts';
import type AgentManifestService from '../manifest/service.ts';
import type { AgentSystemLifecycleFinding } from '../core/lifecycle-registry.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { openclawIntakeAutomationId } from '../agent/openclaw-intake-policy.ts';
import { type CliOutput, type CliStyles, writeCliJson, writeCliLifecycleTable } from './output.ts';
import { lifecycleTableLines, orderDoctorFindings } from '../core/lifecycle-presentation.ts';

function maskedId(value: string): string {
  return `***${value.slice(-4)}`;
}

function humanFinding(
  finding: AgentSystemLifecycleFinding,
  automations: NonNullable<AgentManifest['automations']>,
) {
  const automation =
    finding.component === 'automations'
      ? automations.find(({ id }) => id === finding.stepId)
      : undefined;
  const automationName =
    automation?.thread?.name ??
    (finding.stepId === openclawIntakeAutomationId ? 'ISSUE ASSIGNMENTS' : undefined);
  const deviceId = finding.message.match(/\bDevice ([A-Za-z0-9_-]{8,})/u)?.[1];
  const component =
    finding.component === 'github-intake'
      ? 'GitHub Intake'
      : finding.component === 'automations' && finding.stepId
        ? `${automationName ?? 'Automation'} (${maskedId(finding.stepId)})`
        : finding.component === 'session-dispatch' && deviceId
          ? `Session Dispatch (${maskedId(deviceId)})`
          : finding.component === 'session-dispatch'
            ? 'Session Dispatch'
            : finding.component;
  let message = finding.message;
  let remediation = finding.remediation;
  if (finding.component === 'automations' && finding.stepId) {
    message = message.replace(
      `Automation ${finding.stepId}:`,
      `${automationName ?? 'Automation'}:`,
    );
    message = message.replace(
      /\(persistent, ([^:]+): ([^)]+)\)/u,
      (_match, outcome: string, id: string) => `(persistent, ${outcome}: ${maskedId(id)})`,
    );
  }
  const maskDevice = (text: string) =>
    text.replace(
      /\b(Device )([A-Za-z0-9_-]{8,})/gu,
      (_match, prefix: string, id: string) => `${prefix}${maskedId(id)}`,
    );
  const maskRequest = (text: string) =>
    text.replace(
      /\b(request )([A-Za-z0-9_-]{8,})/giu,
      (_match, prefix: string, id: string) => `${prefix}${maskedId(id)}`,
    );
  message = maskRequest(maskDevice(message));
  if (deviceId) message = message.replace(` Device ${deviceId}.`, '');
  if (remediation) remediation = maskRequest(maskDevice(remediation));
  return {
    component,
    message: `${message}${remediation ? ` ${remediation}` : ''}`,
    status: finding.status,
  };
}

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
async function doctorAgentSystem(options: DoctorAgentSystemOptions): Promise<void> {
  const manifest = await loadCommandManifest(options);
  if (!manifest) return;
  const result = await options.doctorService.inspect({
    runtime: 'openclaw',
    manifest: manifest.manifest,
    workspaceDir: manifest.scope.workspaceDir,
  });
  if (options.json) writeCliJson(options.output, result);
  else {
    writeCliLifecycleTable(
      options.output,
      lifecycleTableLines(
        orderDoctorFindings(result.findings).map((finding) =>
          humanFinding(finding, manifest.manifest.automations ?? []),
        ),
      ),
      result.workspaceDir,
      options.styles,
      options.terminalColumns,
    );
  }
  if (result.status !== 'healthy') options.setExitCode(1);
}

export default presentCliCommand(doctorAgentSystem);
