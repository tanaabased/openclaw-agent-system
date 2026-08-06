import {
  AgentInstallError,
  type default as AgentInstallService,
} from '../lib/agent-install-service.ts';
import type AgentManifestService from '../lib/agent-manifest-service.ts';
import { type CliOutput, type CliStyles, writeCliSummary } from '../lib/cli-output.ts';
import {
  type Logger,
  reportError,
  formatDiagnostic,
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

/** Reconcile the current manifest's OpenClaw agent, identity, and executable paths. */
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
    for (const warning of installed.warnings) {
      options.logger.warn(
        formatDiagnostic({
          code: warning.code,
          component: 'install',
          message: warning.message,
        }),
      );
    }
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
    if (installed.actions.includes('create-workspace-bin')) {
      lines.push({
        label: 'created',
        style: 'action' as const,
        value: 'workspace bin directory',
      });
    }
    if (installed.actions.includes('set-exec-path')) {
      lines.push({
        label: 'updated',
        style: 'action' as const,
        value: `OpenClaw exec path for ${installed.agentId}`,
      });
    }
    if (installed.actions.includes('create-codex-config')) {
      lines.push({
        label: 'created',
        style: 'action' as const,
        value: 'Codex workspace path configuration',
      });
    }
    if (installed.actions.includes('update-codex-config')) {
      lines.push({
        label: 'updated',
        style: 'action' as const,
        value: 'Codex workspace path configuration',
      });
    }
    if (installed.actions.includes('update-gitignore')) {
      lines.push({
        label: 'updated',
        style: 'action' as const,
        value: 'workspace .gitignore',
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
