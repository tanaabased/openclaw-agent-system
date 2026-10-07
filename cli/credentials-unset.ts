import presentCliCommand from './presentation.ts';
import loadCommandManifest from './load-command-manifest.ts';
import type AgentManifestService from '../manifest/service.ts';
import type OpCredentialManager from '../credentials/op-manager.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliError,
  writeCliDiagnosticNotices,
  writeCliSummary,
} from './output.ts';
import { formatDiagnostic } from '../core/logger.ts';

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
async function unsetCredentialsAgentSystem(
  options: UnsetCredentialsAgentSystemOptions,
): Promise<void> {
  if (options.credential !== 'op') {
    writeCliError(
      options.output,
      `credentials: unsupported credential ${options.credential}`,
      options,
    );
    options.setExitCode(1);
    return;
  }
  const loaded = await loadCommandManifest(options);
  if (!loaded) return;
  const result = await options.credentialManager.unset(loaded.manifest.agent.id, options.storeId);
  if (result.gatewayInvalidation === 'pending') {
    writeCliDiagnosticNotices(options, [
      {
        severity: 'warning',
        message:
          'credentials: Gateway invalidation is pending. Run openclaw agent-system credentials cache flush after Gateway access is restored; the store mutation will not be replayed.',
      },
    ]);
  }
  if (result.status === 'invalid') {
    writeCliError(
      options.output,
      formatDiagnostic({ code: result.code, component: 'credentials', message: result.message }),
      options,
    );
    options.setExitCode(1);
    return;
  }
  if (result.gatewayInvalidation === 'confirmed') {
    writeCliSummary(
      options.output,
      [{ label: 'gateway cache', style: 'status', value: 'invalidation confirmed' }],
      options.styles,
    );
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
    writeCliDiagnosticNotices(options, [
      {
        severity: 'warning',
        message: `credentials: unavailable stores were skipped: ${result.unavailableStoreIds.join(', ')}`,
      },
    ]);
  }
}

export default presentCliCommand(unsetCredentialsAgentSystem);
