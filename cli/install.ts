import {
  AgentInstallError,
  type default as AgentInstallService,
} from '../lib/agent-install-service.ts';
import type AgentManifestService from '../lib/agent-manifest-service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliJson,
  writeCliSummary,
} from '../lib/cli-output.ts';
import lifecyclePresentationLines from '../lib/lifecycle-presentation.ts';
import { AgentSystemLifecycleError } from '../lib/lifecycle-registry.ts';
import {
  type Logger,
  reportError,
  formatDiagnostic,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/logger.ts';

export interface InstallAgentSystemOptions {
  installService: Pick<AgentInstallService, 'install'>;
  json: boolean;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
  workspaceDir: string;
}

/** Reconcile every configured lifecycle component for the current workspace manifest. */
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
          component: warning.component,
          message: warning.message,
        }),
      );
    }
    if (options.json) writeCliJson(options.output, installed);
    else {
      const lines = lifecyclePresentationLines(installed.outcomes);
      lines.push({ label: 'workspace', style: 'target' as const, value: installed.workspaceDir });
      writeCliSummary(options.output, lines, options.styles);
    }
  } catch (error) {
    reportError(
      options.logger,
      error instanceof AgentSystemLifecycleError ? error.component : 'install',
      error,
      error instanceof AgentInstallError || error instanceof AgentSystemLifecycleError
        ? error.code
        : undefined,
    );
    options.setExitCode(1);
  }
}
