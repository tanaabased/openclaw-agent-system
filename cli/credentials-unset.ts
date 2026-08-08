import type AgentManifestService from '../lib/agent-manifest-service.ts';
import type OpCredentialManager from '../lib/op-credential-manager.ts';
import { type CliOutput, type CliStyles, writeCliSummary } from '../lib/cli-output.ts';
import {
  formatDiagnostic,
  type Logger,
  reportManifestDiagnostics,
  reportManifestFailure,
} from '../lib/logger.ts';

export interface UnsetCredentialsAgentSystemOptions {
  agentId?: string;
  credential: string;
  credentialManager: Pick<OpCredentialManager, 'unset'>;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output: CliOutput;
  setExitCode(code: number): void;
  storeId?: string;
  styles?: CliStyles;
  workspaceDir: string;
}

/** Remove an agent-scoped OP credential from one exact store or every registered store. */
export default async function unsetCredentialsAgentSystem(
  options: UnsetCredentialsAgentSystemOptions,
): Promise<void> {
  if (options.credential !== 'op') {
    options.logger.error(`credentials: unsupported credential ${options.credential}`);
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

  const result = await options.credentialManager.unset(loaded.manifest.agent.id, options.storeId);
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
        label: result.status === 'removed' ? 'removed' : 'unchanged',
        style: result.status === 'removed' ? 'action' : 'status',
        value: `op credential for ${result.agentId}${result.status === 'missing' ? ' is not stored' : ''}`,
      },
      {
        label: result.storeIds.length === 1 ? 'store' : 'stores',
        style: 'target',
        value: result.storeIds.join(', '),
      },
    ],
    options.styles,
  );
  if (result.unavailableStoreIds.length > 0) {
    options.logger.warn(
      `credentials: unavailable stores were skipped: ${result.unavailableStoreIds.join(', ')}`,
    );
  }
}
