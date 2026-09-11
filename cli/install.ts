import {
  AgentInstallError,
  type default as AgentInstallService,
} from '../agent/install-service.ts';
import type AgentManifestService from '../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnostics,
  writeCliError,
  writeCliJson,
  writeCliLifecycleTable,
} from './output.ts';
import { lifecycleTableLines } from '../core/lifecycle-presentation.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import {
  formatDiagnostic,
  formatErrorDiagnostic,
  formatManifestDiagnostics,
  formatManifestFailure,
} from '../core/logger.ts';

export interface InstallAgentSystemOptions {
  installService: Pick<AgentInstallService, 'install'>;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForCommandDirectory'>;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
  terminalColumns?: number;
  workspaceDir: string;
}

/** Reconcile every configured lifecycle component for the current workspace manifest. */
export default async function installAgentSystem(
  options: InstallAgentSystemOptions,
): Promise<void> {
  const result = await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  if (result.status !== 'loaded') {
    writeCliDiagnostics(
      options.output,
      formatManifestFailure(result).map(({ message }) => message),
    );
    options.setExitCode(1);
    return;
  }

  writeCliDiagnostics(
    options.output,
    formatManifestDiagnostics(result).map(({ message }) => message),
  );
  try {
    const installed = await options.installService.install({
      manifest: result.manifest,
      workspaceDir: result.scope.workspaceDir,
    });
    writeCliDiagnostics(
      options.output,
      installed.warnings.map((warning) =>
        formatDiagnostic({
          code: warning.code,
          component: warning.component,
          message: warning.message,
        }),
      ),
    );
    if (options.json) writeCliJson(options.output, installed);
    else {
      writeCliLifecycleTable(
        options.output,
        lifecycleTableLines(installed.outcomes),
        installed.workspaceDir,
        options.styles,
        options.terminalColumns,
      );
    }
  } catch (error) {
    writeCliError(
      options.output,
      formatErrorDiagnostic(
        error instanceof AgentSystemLifecycleError ? error.component : 'install',
        error,
        error instanceof AgentInstallError || error instanceof AgentSystemLifecycleError
          ? error.code
          : undefined,
      ),
    );
    options.setExitCode(1);
  }
}
