import type AgentInstallService from '../lib/agent-install-service.ts';
import type AgentManifestService from '../lib/agent-manifest-service.ts';
import {
  type CliOutput,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/cli-output.ts';

export interface InstallAgentSystemOptions {
  installService: Pick<AgentInstallService, 'install'>;
  manifestService: Pick<AgentManifestService, 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
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
    reportManifestFailure(result, options.output);
    options.setExitCode(1);
    return;
  }

  reportManifestDiagnostics(result, options.output);
  try {
    const installed = await options.installService.install({
      manifest: result.manifest,
      workspaceDir: result.scope.workspaceDir,
    });
    if (installed.actions.length === 0) {
      options.output.write(
        `unchanged: OpenClaw agent ${installed.agentId} is installed at ${installed.workspaceDir}\n`,
      );
      return;
    }
    if (installed.actions.includes('add-agent')) {
      options.output.write(
        `created: OpenClaw agent ${installed.agentId} at ${installed.workspaceDir}\n`,
      );
    }
    if (installed.actions.includes('set-identity')) {
      options.output.write(`updated: OpenClaw identity for ${installed.agentId}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.output.error(`error: ${message}\n`);
    options.setExitCode(1);
  }
}
