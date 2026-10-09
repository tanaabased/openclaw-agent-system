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
import type GitHubNotificationMonitorService from '../intake/monitor/service.ts';
import {
  NotificationCliOptionError,
  notificationItemSelector,
  notificationTimeoutSeconds,
} from './options.ts';

const defaultRefreshSeconds = 300;
const notificationRefreshLeaseWaitMs = 120_000;

export interface RefreshNotificationsAgentSystemOptions {
  agentId?: string;
  itemKind?: unknown;
  itemNumber?: unknown;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  monitorService: Pick<GitHubNotificationMonitorService, 'runOnce'>;
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

/** Run one bounded notification intake cycle from a one-shot CLI process. */
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
  let result;
  try {
    [result] = await options.monitorService.runOnce({
      agentId: manifest.manifest.agent.id,
      bypassInterval: true,
      executionSurface: 'cli-one-shot',
      ...(parsed.selector === undefined ? {} : { selector: parsed.selector }),
      signal: controller.signal,
      waitForLeaseMs: Math.min(notificationRefreshLeaseWaitMs, parsed.timeoutMs),
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
    const counts = [
      ['baseline', result.baseline],
      ['approved', result.approved],
      ['rejected', result.rejected],
      ['duplicate', result.duplicates],
      ['retired', result.retired],
    ]
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .map(([label, value]) => `${label}=${value}`)
      .join(' ');
    const baseline =
      result.baselineAt === undefined
        ? 'pending'
        : result.baselineEstablished
          ? `established at ${new Date(result.baselineAt).toISOString()} with ${result.baseline ?? 0} existing assignments`
          : `ready since ${new Date(result.baselineAt).toISOString()}`;
    const styles = options.styles;
    const tableOptions = {
      rowPadding: 0 as const,
      terminalColumns: options.terminalColumns ?? process.stdout.columns,
    };
    const disabled = result.code === 'github-notification-disabled';
    const throttled = result.code === 'github-notification-provider-throttle-active';
    const failures = result.itemFailures ?? [];
    const status =
      result.status === 'failed'
        ? 'failed'
        : disabled
          ? 'disabled'
          : throttled
            ? 'throttled'
            : failures.length && result.status === 'completed'
              ? 'completed with item failures'
              : result.status;
    const statusStyle =
      result.status === 'failed'
        ? 'error'
        : disabled
          ? 'field'
          : throttled || failures.length
            ? 'warning'
            : result.status === 'completed'
              ? 'status'
              : 'field';
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
          value: `${parsed.timeoutMs / 1_000}s${options.timeoutSeconds === undefined ? ' (default)' : ''}`,
        },
        {
          label: 'status',
          style: statusStyle,
          valueStyle: statusStyle,
          value: status,
        },
        { label: 'code', style: 'field', value: result.code },
        { label: 'baseline', style: 'field', value: baseline },
        ...(result.diagnosticCode
          ? [{ label: 'diagnostic', style: 'field' as const, value: result.diagnosticCode }]
          : []),
        ...(result.retryAt === undefined
          ? []
          : [
              {
                label: 'retry',
                style: 'field' as const,
                value: new Date(result.retryAt).toISOString(),
              },
            ]),
        ...(result.nextPollAt === undefined
          ? []
          : [
              {
                label: 'next poll',
                style: 'field' as const,
                value: new Date(result.nextPollAt).toISOString(),
              },
            ]),
        ...(counts ? [{ label: 'items', style: 'field' as const, value: counts }] : []),
      ],
      styles,
      tableOptions,
    );
    const failureRows = renderCliSummary(
      failures.map((failure) => ({
        component: `${failure.repository}#${failure.number}`,
        label: 'failure',
        style: 'error' as const,
        value: `${failure.itemType} stage=${failure.stage} cause=${failure.cause}`,
      })),
      styles,
      tableOptions,
    );
    writeCliLines(options.output, [
      '',
      ...summary,
      ...(failureRows.length ? ['', ...failureRows] : []),
      '',
    ]);
    if (failures.length) {
      writeCliDiagnosticNotices(options, [
        { severity: 'error', message: 'check repository write access and retry refresh' },
      ]);
    }
    if (throttled) {
      writeCliDiagnosticNotices(options, [
        {
          severity: 'warning',
          message: 'provider rate limit; wait for it to clear before refreshing again',
        },
      ]);
    } else if (disabled) {
      writeCliDiagnosticNotices(options, [
        { severity: 'notice', message: 'enable github notifications in agent.yaml to refresh' },
      ]);
    } else if (result.status === 'failed') {
      writeCliDiagnosticNotices(options, [
        {
          severity: 'error',
          message: 'inspect the reported code and retry refresh after resolving the cause',
        },
      ]);
    }
  }
  if (result.status !== 'completed') options.setExitCode(1);
}

export default presentCliCommand(refreshNotificationsAgentSystem);
