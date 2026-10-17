import nativeNotificationDiagnostic from './native-diagnostic.ts';
import type OpenClawNotifications from '../../../agent/openclaw-notifications.ts';
import presentCliCommand from '../../../cli/presentation.ts';
import loadCommandManifest from '../../../cli/load-command-manifest.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  createCliStyles,
  renderCliSummary,
  writeCliDiagnosticNotices,
  writeCliError,
  writeCliJson,
  writeCliLines,
} from '../../../cli/output.ts';
import { formatRedactedErrorDiagnostic } from '../../../core/logger.ts';
import { NotificationCliOptionError, notificationItemSelector } from './options.ts';

export interface StatusNotificationsAgentSystemOptions {
  nativeService?: Pick<OpenClawNotifications, 'inspect'>;
  agentId?: string;
  itemKind?: unknown;
  itemNumber?: unknown;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  output: CliOutput;
  repository?: unknown;
  setExitCode(code: number): void;
  styles?: CliStyles;
  terminalColumns?: number;
  workspaceDir: string;
}

/** Report one redacted semantic projection of durable notification state. */
async function statusNotificationsAgentSystem(
  options: StatusNotificationsAgentSystemOptions,
): Promise<void> {
  let selector;
  try {
    selector = notificationItemSelector({
      kind: options.itemKind,
      number: options.itemNumber,
      repository: options.repository,
    });
  } catch (error) {
    writeCliError(
      options.output,
      `github-notifications: invalid status options code=github-notification-status-options-invalid message=${error instanceof NotificationCliOptionError ? error.message : 'unknown'}`,
      options,
    );
    options.setExitCode(2);
    return;
  }
  const manifest = await loadCommandManifest(options);
  if (!manifest) return;

  let result;
  try {
    if (!options.nativeService) throw new Error('native notification backend is unavailable');
    result = await options.nativeService.inspect(
      manifest.manifest,
      manifest.scope.workspaceDir,
      selector,
    );
  } catch (error) {
    writeCliError(
      options.output,
      formatRedactedErrorDiagnostic(
        'github-notifications',
        error,
        'github-notification-status-failed',
      ),
      options,
    );
    options.setExitCode(1);
    return;
  }
  if (options.json) {
    writeCliJson(options.output, result);
  } else {
    const styles = options.styles ?? createCliStyles();
    const tableOptions = {
      rowPadding: 0 as const,
      terminalColumns: options.terminalColumns ?? process.stdout.columns,
    };
    const statusStyle =
      result.status === 'degraded' ? 'error' : result.status === 'pending' ? 'warning' : 'status';
    const summary = renderCliSummary(
      [
        { label: 'agent', style: 'target', value: result.agentId },
        {
          label: 'scope',
          style: 'field',
          value: selector
            ? `${selector.itemType} ${selector.repository}#${selector.number}`
            : 'all items',
        },
        { label: 'status', style: 'field', value: result.status, valueStyle: statusStyle },
        { label: 'code', style: 'field', value: result.code, quiet: true },
        {
          label: 'baseline',
          style: 'field',
          value: result.baseline.status,
          valueStyle: result.baseline.status === 'pending' ? 'warning' : 'field',
        },
        ...(result.scan
          ? [
              {
                label: 'scan',
                style: 'field' as const,
                value:
                  result.scan.completedAt === undefined
                    ? 'pending'
                    : `completed at ${new Date(result.scan.completedAt).toISOString()}`,
              },
            ]
          : []),
        {
          label: 'capacity',
          style: 'field',
          value: `agent-wide active=${result.capacity.active} queued=${result.capacity.queued} limit=${result.capacity.limit}`,
          quiet: true,
        },
      ],
      styles,
      tableOptions,
    );
    const items = result.items.flatMap((item, index) => [
      ...(index ? [''] : []),
      ...renderCliSummary(
        [
          {
            component: `${item.repository}#${item.number}`,
            label: item.disposition,
            style: 'field',
            quiet: true,
            value: `${item.itemType} stage=${item.workflow?.phase ?? item.stage ?? 'none'}`,
          },
        ],
        styles,
        tableOptions,
      ),
      ...renderCliSummary(
        [
          {
            label: 'worktree',
            style: 'field',
            quiet: true,
            value: `${item.worktree}${item.scheduling === undefined ? '' : ` scheduling=${item.scheduling}`}`,
          },
          ...(item.workflow?.conversation
            ? [
                {
                  label: 'conversation',
                  style: 'field' as const,
                  quiet: true,
                  value: item.workflow.conversation,
                },
              ]
            : []),
          ...(item.waitingReason === undefined
            ? []
            : [{ label: 'waiting', style: 'warning' as const, value: item.waitingReason }]),
          ...(item.failureCode === undefined
            ? []
            : [{ label: 'failure', style: 'error' as const, value: item.failureCode }]),
        ],
        styles,
        tableOptions,
      ),
    ]);
    writeCliLines(options.output, [
      '',
      ...summary,
      '',
      styles.bold('items'),
      '',
      ...(items.length ? items : [styles.field(selector ? 'no matching items' : 'no items')]),
      '',
    ]);
  }
  if (result.warnings?.length)
    writeCliDiagnosticNotices(
      options,
      result.warnings
        .filter(
          (warning) =>
            !manifest.diagnostics.some(
              ({ code, fieldPath }) => code === warning.code && fieldPath === warning.fieldPath,
            ),
        )
        .map(({ message }) => ({ severity: 'warning' as const, message })),
    );
  const remediation = nativeNotificationDiagnostic(result.code);
  if (remediation)
    writeCliDiagnosticNotices(options, [{ severity: 'error', message: remediation }]);
  if (result.status === 'degraded') options.setExitCode(1);
}

export default presentCliCommand(statusNotificationsAgentSystem);
