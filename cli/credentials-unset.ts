import type AgentManifestService from '../lib/agent-manifest-service.ts';
import type OnePasswordCredentialManager from '../lib/onepassword-credential-manager.ts';
import {
  type CliOutput,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/cli-output.ts';

export interface UnsetCredentialsAgentSystemOptions {
  agentId?: string;
  credential: string;
  credentialManager: Pick<OnePasswordCredentialManager, 'unset'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
  storeId?: string;
  workspaceDir: string;
}

/** Remove an agent-scoped OP credential from an explicit store. */
export default async function unsetCredentialsAgentSystem(
  options: UnsetCredentialsAgentSystemOptions,
): Promise<void> {
  if (options.credential !== 'op') {
    options.output.error(`error: unsupported credential ${options.credential}\n`);
    options.setExitCode(1);
    return;
  }
  if (!options.storeId) {
    options.output.error('error: credentials unset op requires --store <id>\n');
    options.setExitCode(1);
    return;
  }

  const loaded = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForWorkspace(options.workspaceDir, undefined, 'cli');
  if (loaded.status !== 'loaded') {
    reportManifestFailure(loaded, options.output);
    options.setExitCode(1);
    return;
  }
  reportManifestDiagnostics(loaded, options.output);

  const result = await options.credentialManager.unset(loaded.manifest.agent.id, options.storeId);
  if (result.status === 'invalid') {
    options.output.error(`error: [${result.code}] ${result.message}\n`);
    options.setExitCode(1);
    return;
  }
  options.output.write(
    result.status === 'removed'
      ? `removed: op credential for ${result.agentId} store=${result.storeId}\n`
      : `unchanged: op credential for ${result.agentId} is not stored in ${result.storeId}\n`,
  );
}
