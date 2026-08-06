import type AgentManifestService from '../lib/agent-manifest-service.ts';
import type OnePasswordCredentialManager from '../lib/onepassword-credential-manager.ts';
import {
  type CliOutput,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/cli-output.ts';

export interface ValidateCredentialsAgentSystemOptions {
  agentId?: string;
  credential: string;
  credentialManager: Pick<OnePasswordCredentialManager, 'validate'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
  storeId?: string;
  workspaceDir: string;
}

/** Validate an OP credential against every Environment declared by the manifest. */
export default async function validateCredentialsAgentSystem(
  options: ValidateCredentialsAgentSystemOptions,
): Promise<void> {
  if (options.credential !== 'op') {
    options.output.error(`error: unsupported credential ${options.credential}\n`);
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

  const result = await options.credentialManager.validate(loaded.manifest, options.storeId);
  if (result.status === 'invalid') {
    options.output.error(`error: [${result.code}] ${result.message}\n`);
    options.setExitCode(1);
    return;
  }
  options.output.write(
    `valid: op credential for ${result.agentId} source=${result.source} environments=${result.environmentCount}\n`,
  );
}
