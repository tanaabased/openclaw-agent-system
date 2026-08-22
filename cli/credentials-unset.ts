import type AgentManifestService from '../manifest/service.ts';
import type OpCredentialManager from '../credentials/op-manager.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnostics,
  writeCliError,
  writeCliSummary,
} from './output.ts';
import {
  formatDiagnostic,
  formatManifestDiagnostics,
  formatManifestFailure,
} from '../core/logger.ts';

export interface UnsetCredentialsAgentSystemOptions {
  agentId?: string;
  credential: string;
  credentialManager: Pick<OpCredentialManager, 'unset'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
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
    writeCliError(options.output, `credentials: unsupported credential ${options.credential}`);
    options.setExitCode(1);
    return;
  }
  const loaded = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  if (loaded.status !== 'loaded') {
    writeCliDiagnostics(
      options.output,
      formatManifestFailure(loaded).map(({ message }) => message),
    );
    options.setExitCode(1);
    return;
  }
  writeCliDiagnostics(
    options.output,
    formatManifestDiagnostics(loaded).map(({ message }) => message),
  );

  const result = await options.credentialManager.unset(loaded.manifest.agent.id, options.storeId);
  if (result.status === 'invalid') {
    writeCliError(
      options.output,
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
    writeCliError(
      options.output,
      `credentials: unavailable stores were skipped: ${result.unavailableStoreIds.join(', ')}`,
    );
  }
}
