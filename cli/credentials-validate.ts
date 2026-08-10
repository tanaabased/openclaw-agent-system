import type AgentManifestService from '../lib/agent-manifest-service.ts';
import type OpCredentialManager from '../lib/op-credential-manager.ts';
import { type CliOutput, type CliStyles, writeCliSummary } from '../lib/cli-output.ts';
import {
  formatDiagnostic,
  type Logger,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/logger.ts';

export interface ValidateCredentialsAgentSystemOptions {
  agentId?: string;
  credential: string;
  credentialManager: Pick<OpCredentialManager, 'validate'>;
  fromEnvironment: boolean;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  output: CliOutput;
  setExitCode(code: number): void;
  storeId?: string;
  styles?: CliStyles;
  workspaceDir: string;
}

/** Validate an OP credential against every OP resource declared by the manifest. */
export default async function validateCredentialsAgentSystem(
  options: ValidateCredentialsAgentSystemOptions,
): Promise<void> {
  if (options.credential !== 'op') {
    options.logger.error(`credentials: unsupported credential ${options.credential}`);
    options.setExitCode(1);
    return;
  }
  if (options.fromEnvironment && options.storeId) {
    options.logger.error('credentials: --from-env and --store cannot be used together');
    options.setExitCode(1);
    return;
  }

  const loaded = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  if (loaded.status !== 'loaded') {
    reportManifestFailure(loaded, options.logger);
    options.setExitCode(1);
    return;
  }
  reportManifestDiagnostics(loaded, options.logger);

  const result = await options.credentialManager.validate(loaded.manifest, {
    ...(options.fromEnvironment ? { fromEnvironment: true } : {}),
    ...(options.storeId ? { storeId: options.storeId } : {}),
  });
  if (result.status === 'invalid') {
    options.logger.error(
      formatDiagnostic({ code: result.code, component: 'credentials', message: result.message }),
    );
    options.setExitCode(1);
    return;
  }
  writeCliSummary(
    options.output,
    [
      { label: 'valid', style: 'status', value: `op credential for ${result.agentId}` },
      { label: 'source', style: 'target', value: result.source },
      { label: 'environments', style: 'field', value: String(result.environmentCount) },
      { label: 'secrets', style: 'field', value: String(result.secretCount) },
    ],
    options.styles,
  );
}
