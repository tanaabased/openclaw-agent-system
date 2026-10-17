import presentCliCommand from './presentation.ts';
import loadCommandManifest from './load-command-manifest.ts';
import type AgentManifestService from '../manifest/service.ts';
import type OpCredentialManager from '../credentials/op-manager.ts';
import {
  type CliOutput,
  type CliStyles,
  type CliSummaryLine,
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
  terminalColumns?: number;
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
          'credentials: gateway invalidation is pending. run openclaw agent-system credentials cache flush after gateway access is restored; the store mutation will not be replayed.',
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
  const lines: CliSummaryLine[] = [
    { label: 'credential', style: 'field', value: options.credential },
    { label: 'agent', style: 'target', value: result.agentId },
    {
      label: 'scope',
      style: 'field',
      value: options.storeId ? `one store (${options.storeId})` : 'all stores',
    },
    ...result.storeIds.map((storeId): CliSummaryLine => ({
      component: storeId,
      label: result.status === 'removed' ? 'removed' : 'unchanged',
      style: result.status === 'removed' ? 'status' : 'field',
      quiet: result.status === 'missing',
      value: result.status === 'removed' ? 'op credential removed' : 'op credential is not stored',
    })),
    ...result.unavailableStoreIds.map((storeId): CliSummaryLine => ({
      component: storeId,
      label: 'unavailable',
      style: 'warning',
      value: 'removal skipped',
    })),
  ];
  if (result.gatewayInvalidation) {
    lines.push({
      label: 'gateway cache',
      style: result.gatewayInvalidation === 'confirmed' ? 'field' : 'warning',
      quiet: result.gatewayInvalidation === 'confirmed',
      value: `invalidation ${result.gatewayInvalidation}`,
    });
  }
  options.output.writeStdout('\n');
  writeCliSummary(options.output, lines, options.styles, {
    rowPadding: 0,
    terminalColumns: options.terminalColumns,
  });
  options.output.writeStdout('\n');
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
