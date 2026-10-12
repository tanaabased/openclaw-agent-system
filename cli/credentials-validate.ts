import presentCliCommand from './presentation.ts';
import loadCommandManifest from './load-command-manifest.ts';
import type AgentManifestService from '../manifest/service.ts';
import type OpCredentialManager from '../credentials/op-manager.ts';
import {
  type CliOutput,
  type CliNotice,
  type CliStyles,
  writeCliDiagnosticNotices,
  writeCliError,
  writeCliSummary,
} from './output.ts';
import { formatDiagnostic } from '../core/logger.ts';

export interface ValidateCredentialsAgentSystemOptions {
  agentId?: string;
  credential: string;
  credentialManager: Pick<OpCredentialManager, 'validate'>;
  fromEnvironment: boolean;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  output: CliOutput;
  setExitCode(code: number): void;
  storeId?: string;
  styles?: CliStyles;
  terminalColumns?: number;
  workspaceDir: string;
}

/** Validate an OP credential against every OP resource declared by the manifest. */
async function validateCredentialsAgentSystem(
  options: ValidateCredentialsAgentSystemOptions,
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
  if (options.fromEnvironment && options.storeId) {
    writeCliError(
      options.output,
      'credentials: --from-env and --store cannot be used together',
      options,
    );
    options.setExitCode(1);
    return;
  }

  const loaded = await loadCommandManifest(options);
  if (!loaded) return;
  const result = await options.credentialManager.validate(loaded.manifest, {
    ...(options.fromEnvironment ? { fromEnvironment: true } : {}),
    ...(options.storeId ? { storeId: options.storeId } : {}),
  });
  if (result.status === 'invalid') {
    const notices: CliNotice[] = [];
    if (result.gatewayInvalidation === 'pending') {
      notices.push({
        severity: 'warning',
        message:
          'credentials: Gateway invalidation is pending; restore Gateway access and run openclaw agent-system credentials cache flush. code=credentials-gateway-invalidation-pending',
      });
    }

    notices.push({
      severity: 'error',
      message: formatDiagnostic({
        code: result.code,
        component: 'credentials',
        message: result.message,
      }),
    });
    writeCliDiagnosticNotices(options, notices);
    options.setExitCode(1);
    return;
  }
  writeCliSummary(
    options.output,
    [
      { label: 'status', style: 'status', value: 'valid' },
      { label: 'agent', style: 'target', value: result.agentId },
      {
        label: result.source === 'process-environment' ? 'source' : 'store',
        style: 'target',
        value: result.source.startsWith('store:')
          ? result.source.slice('store:'.length)
          : result.source,
      },
      { label: 'environments checked', style: 'field', value: String(result.environmentCount) },
      { label: 'secrets checked', style: 'field', value: String(result.secretCount) },
    ],
    options.styles,
    { rowPadding: 0, terminalColumns: options.terminalColumns },
  );
}

export default presentCliCommand(validateCredentialsAgentSystem);
