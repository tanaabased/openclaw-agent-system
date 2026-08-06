import {
  AgentInstallError,
  type default as AgentInstallService,
} from '../lib/agent-install-service.ts';
import type AgentManifestService from '../lib/agent-manifest-service.ts';
import { type CliOutput, type CliStyles, writeCliSummary } from '../lib/cli-output.ts';
import {
  type Logger,
  reportError,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/logger.ts';

export interface InstallAgentSystemOptions {
  installService: Pick<AgentInstallService, 'install'>;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
  workspaceDir: string;
}

/** Reconcile the current manifest's OpenClaw agent registration and public identity. */
export default async function installAgentSystem(
  options: InstallAgentSystemOptions,
): Promise<void> {
  const result = await options.manifestService.loadForWorkspace(
    options.workspaceDir,
    undefined,
    'cli',
  );
  if (result.status !== 'loaded') {
    reportManifestFailure(result, options.logger);
    options.setExitCode(1);
    return;
  }

  reportManifestDiagnostics(result, options.logger);
  try {
    const installed = await options.installService.install({
      manifest: result.manifest,
      workspaceDir: result.scope.workspaceDir,
    });
    if (installed.actions.length === 0) {
      writeCliSummary(
        options.output,
        [
          {
            label: 'unchanged',
            style: 'status',
            value: `OpenClaw agent ${installed.agentId}`,
          },
          { label: 'workspace', style: 'target', value: installed.workspaceDir },
        ],
        options.styles,
      );
      return;
    }
    const lines = [];
    if (installed.actions.includes('add-agent')) {
      lines.push({
        label: 'created',
        style: 'action' as const,
        value: `OpenClaw agent ${installed.agentId}`,
      });
    }
    if (installed.actions.includes('set-identity')) {
      lines.push({
        label: 'updated',
        style: 'action' as const,
        value: `OpenClaw identity for ${installed.agentId}`,
      });
    }
    lines.push({ label: 'workspace', style: 'target' as const, value: installed.workspaceDir });
    writeCliSummary(options.output, lines, options.styles);
  } catch (error) {
    reportError(
      options.logger,
      'install',
      error,
      error instanceof AgentInstallError ? error.code : undefined,
    );
    options.setExitCode(1);
  }
}
