import nativeNotificationDiagnostic from './native-diagnostic.ts';
import type { NotificationRefreshResult } from '../../../agent/openclaw-notifications.ts';
import type OpenClawNotifications from '../../../agent/openclaw-notifications.ts';
import presentCliCommand from '../../../cli/presentation.ts';
import loadCommandManifest from '../../../cli/load-command-manifest.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliError,
  writeCliJson,
  renderCliSummary,
  writeCliDiagnosticNotices,
  writeCliLines,
} from '../../../cli/output.ts';
import { formatRedactedErrorDiagnostic } from '../../../core/logger.ts';
import {
  NotificationCliOptionError,
  notificationItemSelector,
  notificationTimeoutSeconds,
} from './options.ts';

const defaultRefreshSeconds = 300;

export interface RefreshNotificationsAgentSystemOptions {
  nativeService?: Pick<OpenClawNotifications, 'refresh'>;
  agentId?: string;
  itemKind?: unknown;
  itemNumber?: unknown;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  output: CliOutput;
  repository?: unknown;
  setExitCode(code: number): void;
  styles?: CliStyles;
  timeoutSeconds?: unknown;
  terminalColumns?: number;
  workspaceDir: string;
}

function refreshOptions(options: RefreshNotificationsAgentSystemOptions) {
  return {
    selector: notificationItemSelector({
      kind: options.itemKind,
      number: options.itemNumber,
      repository: options.repository,
    }),
    timeoutMs:
      (options.timeoutSeconds === undefined
        ? defaultRefreshSeconds
        : notificationTimeoutSeconds(options.timeoutSeconds)) * 1_000,
  };
}

/** Request a bounded native notification workflow run from the CLI. */
async function refreshNotificationsAgentSystem(
  options: RefreshNotificationsAgentSystemOptions,
): Promise<void> {
  let parsed;
  try {
    parsed = refreshOptions(options);
  } catch (error) {
    writeCliError(
      options.output,
      `github-notifications: invalid refresh options code=github-notification-refresh-options-invalid message=${error instanceof NotificationCliOptionError ? error.message : 'unknown'}`,
      options,
    );
    options.setExitCode(2);
    return;
  }
  const manifest = await loadCommandManifest(options);
  if (!manifest) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parsed.timeoutMs);
  timeout.unref();
  let result: NotificationRefreshResult | undefined;
  try {
    if (!options.nativeService) throw new Error('native notification backend is unavailable');
    result = await options.nativeService.refresh(manifest.manifest, manifest.scope.workspaceDir, {
      selector: parsed.selector,
      signal: controller.signal,
    });
  } catch (error) {
    writeCliError(
      options.output,
      formatRedactedErrorDiagnostic(
        'github-notifications',
        error,
        'github-notification-refresh-failed',
      ),
      options,
    );
    options.setExitCode(1);
    return;
  } finally {
    clearTimeout(timeout);
  }
  if (!result) {
    writeCliError(
      options.output,
      'github-notifications: manual refresh returned no result',
      options,
    );
    options.setExitCode(1);
    return;
  }

  if (options.json) {
    writeCliJson(options.output, result);
  } else {
    const baseline =
      result.baselineAt === undefined
        ? 'pending'
        : `ready since ${new Date(result.baselineAt).toISOString()}`;
    const statusStyle =
      result.status === 'failed'
        ? ('error' as const)
        : result.status === 'queued'
          ? ('status' as const)
          : ('field' as const);
    const summary = renderCliSummary(
      [
        { label: 'agent', style: 'target', value: result.agentId },
        {
          label: 'scope',
          style: 'target',
          value: parsed.selector
            ? `${parsed.selector.itemType} ${parsed.selector.repository}#${parsed.selector.number}`
            : 'all items',
        },
        {
          label: 'timeout',
          style: 'field',
          value: `${parsed.timeoutMs / 1000}s${options.timeoutSeconds === undefined ? ' (default)' : ''}`,
        },
        { label: 'status', style: statusStyle, valueStyle: statusStyle, value: result.status },
        { label: 'code', style: 'field', value: result.code },
        { label: 'baseline', style: 'field', value: baseline },
        ...(result.runId ? [{ label: 'run', style: 'field' as const, value: result.runId }] : []),
        ...(result.diagnosticCode
          ? [{ label: 'diagnostic', style: 'field' as const, value: result.diagnosticCode }]
          : []),
      ],
      options.styles,
      { rowPadding: 0, terminalColumns: options.terminalColumns ?? process.stdout.columns },
    );
    writeCliLines(options.output, ['', ...summary, '']);
  }
  const remediation = nativeNotificationDiagnostic(result.code);
  if (result.status === 'failed' || remediation)
    writeCliDiagnosticNotices(options, [
      {
        severity: 'error',
        component: 'github-notifications',
        resource: parsed.selector
          ? `${parsed.selector.itemType}:${parsed.selector.repository}#${parsed.selector.number}`
          : manifest.manifest.agent.id,
        occurrence: result.runId,
        code: result.code,
        message: `notification refresh ${result.status}.`,
        details: result.diagnosticCode ? [`diagnostic=${result.diagnosticCode}`] : [],
        remediation: [
          remediation ??
            'inspect the reported code and resolve the cause before requesting another refresh',
        ],
      },
    ]);
  if (
    result.status !== 'queued' &&
    result.status !== 'completed' &&
    result.code !== 'github-notification-refresh-already-running'
  )
    options.setExitCode(1);
}

export default presentCliCommand(refreshNotificationsAgentSystem);
