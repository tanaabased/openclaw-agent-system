import type GitHubNotificationMonitorService from '../channels/github/lib/monitor-service.ts';
import type AgentManifestService from '../lib/agent-manifest-service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliJson,
  writeCliSummary,
} from '../lib/cli-output.ts';
import { type Logger, reportManifestFailure } from '../lib/logger.ts';
import { NotificationCliOptionError, notificationItemSelector } from './notifications-options.ts';

const notificationRefreshLeaseWaitMs = 120_000;

export interface RefreshNotificationsAgentSystemOptions {
  agentId?: string;
  itemKind?: unknown;
  itemNumber?: unknown;
  json: boolean;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  monitorService: Pick<GitHubNotificationMonitorService, 'runOnce'>;
  output: CliOutput;
  repository?: unknown;
  setExitCode(code: number): void;
  styles?: CliStyles;
  workspaceDir: string;
}

/** Run one notification intake cycle while retaining active failure backoff. */
export default async function refreshNotificationsAgentSystem(
  options: RefreshNotificationsAgentSystemOptions,
): Promise<void> {
  let selector;
  try {
    selector = notificationItemSelector({
      kind: options.itemKind,
      number: options.itemNumber,
      repository: options.repository,
    });
  } catch (error) {
    options.logger.error(
      `github-notifications: invalid refresh options code=github-notification-refresh-options-invalid message=${error instanceof NotificationCliOptionError ? error.message : 'unknown'}`,
    );
    options.setExitCode(2);
    return;
  }
  const manifest = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  if (manifest.status !== 'loaded') {
    reportManifestFailure(manifest, options.logger);
    options.setExitCode(1);
    return;
  }

  const [result] = await options.monitorService.runOnce({
    agentId: manifest.manifest.agent.id,
    bypassInterval: true,
    ...(selector === undefined ? {} : { selector }),
    waitForLeaseMs: notificationRefreshLeaseWaitMs,
  });
  if (!result) {
    options.logger.error('github-notifications: manual refresh returned no result');
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
    writeCliSummary(
      options.output,
      [
        { label: 'agent', style: 'target', value: result.agentId },
        {
          label: 'status',
          style: result.status === 'failed' ? 'error' : 'status',
          value: result.status,
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
        ...(result.nextPollAt === undefined || result.retryAt !== undefined
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
      options.styles,
    );
  }
  if (result.status !== 'completed') options.setExitCode(1);
}
