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
import type GitHubNotificationStatusService from '../intake/monitor/status-service.ts';
import { NotificationCliOptionError, notificationItemSelector } from './options.ts';

export interface StatusNotificationsAgentSystemOptions {
  agentId?: string;
  itemKind?: unknown;
  itemNumber?: unknown;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  output: CliOutput;
  repository?: unknown;
  setExitCode(code: number): void;
  statusService: Pick<GitHubNotificationStatusService, 'inspect'>;
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

  const result = await options.statusService.inspect(manifest.manifest.agent.id, selector);
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
            value: `${item.itemType} stage=${item.stage ?? 'none'}`,
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
          ...(item.waitingReason === undefined
            ? []
            : [{ label: 'waiting', style: 'warning' as const, value: item.waitingReason }]),
          ...(item.failureCode === undefined
            ? []
            : [{ label: 'failure', style: 'error' as const, value: item.failureCode }]),
          ...(item.cleanup === undefined
            ? []
            : [
                {
                  label: 'cleanup',
                  style:
                    item.cleanup.status === 'failed'
                      ? ('error' as const)
                      : item.cleanup.status === 'skipped'
                        ? ('warning' as const)
                        : ('field' as const),
                  quiet: true,
                  value: [
                    item.cleanup.status,
                    `session=${item.cleanup.session} cleanup-worktree=${item.cleanup.worktree}`,
                    `cleanup-reason=${item.cleanup.reasonCode}`,
                  ].join('\n'),
                },
              ]),
        ],
        styles,
        tableOptions,
      ),
    ]);
    const failures = renderCliSummary(
      (result.itemFailures ?? []).map((failure) => ({
        component: `${failure.repository}#${failure.number}`,
        label: 'failure',
        style: 'error',
        value: `${failure.itemType} stage=${failure.stage} cause=${failure.cause}`,
      })),
      styles,
      tableOptions,
    );
    writeCliLines(options.output, [
      '',
      ...summary,
      '',
      styles.bold('items'),
      '',
      ...(items.length ? items : [styles.field(selector ? 'no matching items' : 'no items')]),
      ...(failures.length ? ['', styles.bold('attention'), '', ...failures] : []),
      '',
    ]);
    if (failures.length) {
      writeCliDiagnosticNotices(options, [
        { severity: 'error', message: 'check repository write access and retry refresh' },
      ]);
    }
  }
  if (result.status === 'degraded') options.setExitCode(1);
}

export default presentCliCommand(statusNotificationsAgentSystem);
