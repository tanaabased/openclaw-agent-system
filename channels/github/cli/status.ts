import type AgentManifestService from '../../../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnostics,
  writeCliError,
  writeCliJson,
  writeCliSummary,
} from '../../../cli/output.ts';
import { formatManifestFailure } from '../../../core/logger.ts';
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
  workspaceDir: string;
}

/** Report one redacted semantic projection of durable notification state. */
export default async function statusNotificationsAgentSystem(
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
    );
    options.setExitCode(2);
    return;
  }
  const manifest = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  if (manifest.status !== 'loaded') {
    writeCliDiagnostics(
      options.output,
      formatManifestFailure(manifest).map(({ message }) => message),
    );
    options.setExitCode(1);
    return;
  }

  const result = await options.statusService.inspect(manifest.manifest.agent.id, selector);
  if (options.json) {
    writeCliJson(options.output, result);
  } else {
    writeCliSummary(
      options.output,
      [
        { label: 'agent', style: 'target', value: result.agentId },
        {
          label: 'status',
          style:
            result.status === 'degraded'
              ? 'error'
              : result.status === 'pending'
                ? 'warning'
                : 'status',
          value: result.status,
        },
        { label: 'code', style: 'field', value: result.code },
        { label: 'baseline', style: 'field', value: result.baseline.status },
        ...result.items.map((item) => ({
          component: `${item.repository}#${item.number}`,
          label: 'item',
          style: 'field' as const,
          value: [
            item.itemType,
            item.disposition,
            `stage=${item.stage ?? 'none'}`,
            `worktree=${item.worktree}`,
            ...(item.cleanup === undefined
              ? []
              : [
                  `cleanup=${item.cleanup.status}`,
                  `session=${item.cleanup.session}`,
                  `cleanup-worktree=${item.cleanup.worktree}`,
                  `cleanup-reason=${item.cleanup.reasonCode}`,
                ]),
          ].join(' '),
        })),
      ],
      options.styles,
    );
  }
  if (result.status === 'degraded') options.setExitCode(1);
}
