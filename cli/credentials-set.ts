import type AgentManifestService from '../lib/agent-manifest-service.ts';
import type OpCredentialInput from '../lib/op-credential-input.ts';
import type OpCredentialManager from '../lib/op-credential-manager.ts';
import { type CliOutput, type CliStyles, writeCliSummary } from '../lib/cli-output.ts';
import {
  formatDiagnostic,
  type Logger,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/logger.ts';

export interface SetCredentialsAgentSystemOptions {
  agentId?: string;
  credential: string;
  credentialInput: Pick<OpCredentialInput, 'read'>;
  credentialManager: Pick<OpCredentialManager, 'set'>;
  fromEnvironment: boolean;
  fromStdin: boolean;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
  storeId?: string;
  styles?: CliStyles;
  workspaceDir: string;
}

/** Validate and persist an OP service-account token from one explicit or interactive source. */
export default async function setCredentialsAgentSystem(
  options: SetCredentialsAgentSystemOptions,
): Promise<void> {
  if (options.credential !== 'op') {
    options.logger.error(`credentials: unsupported credential ${options.credential}`);
    options.setExitCode(1);
    return;
  }
  if (options.fromEnvironment && options.fromStdin) {
    options.logger.error('credentials: --from-env and --stdin cannot be used together');
    options.setExitCode(1);
    return;
  }

  const loaded = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForWorkspace(options.workspaceDir, undefined, 'cli');
  if (loaded.status !== 'loaded') {
    reportManifestFailure(loaded, options.logger);
    options.setExitCode(1);
    return;
  }
  reportManifestDiagnostics(loaded, options.logger);

  const input = await options.credentialInput.read(
    options.fromEnvironment ? 'environment' : options.fromStdin ? 'stdin' : 'prompt',
  );
  if (input.status === 'invalid') {
    options.logger.error(
      formatDiagnostic({ code: input.code, component: 'credentials', message: input.message }),
    );
    options.setExitCode(1);
    return;
  }

  const result = await options.credentialManager.set(loaded.manifest, input.token, options.storeId);
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
      {
        label: result.status,
        style: result.status === 'stored' ? 'action' : 'status',
        value: `op credential for ${result.agentId}`,
      },
      { label: 'store', style: 'target', value: result.storeId },
    ],
    options.styles,
  );
}
