import presentCliCommand from '../../../cli/presentation.ts';
import loadCommandManifest from '../../../cli/load-command-manifest.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliError,
  writeCliJson,
  writeCliSummary,
} from '../../../cli/output.ts';
import { formatRedactedErrorDiagnostic } from '../../../core/logger.ts';
import type GitHubNotificationStatusService from '../intake/monitor/status-service.ts';
import {
  githubNotificationWaitTargets,
  type GitHubNotificationWaitTarget,
} from '../intake/monitor/status.ts';
import {
  NotificationCliOptionError,
  notificationItemSelector,
  notificationTimeoutSeconds,
} from './options.ts';

const defaultWaitSeconds = 300;

export interface WaitNotificationsAgentSystemOptions {
  agentId?: string;
  itemKind?: unknown;
  itemNumber?: unknown;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  output: CliOutput;
  refresh: boolean;
  repository?: unknown;
  setExitCode(code: number): void;
  statusService: Pick<GitHubNotificationStatusService, 'wait'>;
  styles?: CliStyles;
  target?: unknown;
  timeoutSeconds?: unknown;
  workspaceDir: string;
}

function waitOptions(options: WaitNotificationsAgentSystemOptions) {
  if (
    typeof options.target !== 'string' ||
    !githubNotificationWaitTargets.has(options.target as GitHubNotificationWaitTarget)
  ) {
    throw new NotificationCliOptionError(
      `for must be one of ${[...githubNotificationWaitTargets].join(', ')}.`,
    );
  }
  const target = options.target as GitHubNotificationWaitTarget;
  const selector = notificationItemSelector({
    kind: options.itemKind,
    number: options.itemNumber,
    repository: options.repository,
  });
  if (target !== 'baseline-ready' && !selector) {
    throw new NotificationCliOptionError(
      'repository, kind, and number are required for item wait targets.',
    );
  }
  const timeoutSeconds =
    options.timeoutSeconds === undefined
      ? defaultWaitSeconds
      : notificationTimeoutSeconds(options.timeoutSeconds);
  return { selector, target, timeoutMs: timeoutSeconds * 1_000 };
}

/** Wait for one semantic notification checkpoint with optional one-shot intake refresh. */
async function waitNotificationsAgentSystem(
  options: WaitNotificationsAgentSystemOptions,
): Promise<void> {
  let parsed;
  try {
    parsed = waitOptions(options);
  } catch (error) {
    writeCliError(
      options.output,
      `github-notifications: invalid wait options code=github-notification-wait-options-invalid message=${error instanceof NotificationCliOptionError ? error.message : 'unknown'}`,
      options,
    );
    options.setExitCode(2);
    return;
  }
  const manifest = await loadCommandManifest(options);
  if (!manifest) return;

  let result;
  try {
    result = await options.statusService.wait({
      agentId: manifest.manifest.agent.id,
      executionSurface: 'cli-one-shot',
      refresh: options.refresh,
      ...(parsed.selector === undefined ? {} : { selector: parsed.selector }),
      target: parsed.target,
      timeoutMs: parsed.timeoutMs,
    });
  } catch (error) {
    writeCliError(
      options.output,
      formatRedactedErrorDiagnostic(
        'github-notifications',
        error,
        'github-notification-wait-failed',
      ),
      options,
    );
    options.setExitCode(1);
    return;
  }
  if (options.json) {
    writeCliJson(options.output, result);
  } else {
    const selectedItem = parsed.selector
      ? result.observation.items.find(
          (item) =>
            item.repository === parsed.selector?.repository &&
            item.itemType === parsed.selector?.itemType &&
            item.number === parsed.selector?.number,
        )
      : undefined;
    const observed = [
      `status=${result.observation.status}`,
      `code=${result.observation.code}`,
      ...(parsed.target === 'baseline-ready'
        ? [`baseline=${result.observation.baseline.status}`]
        : selectedItem
          ? [
              `item=${selectedItem.disposition}`,
              ...(selectedItem.stage ? [`stage=${selectedItem.stage}`] : []),
              `worktree=${selectedItem.worktree}`,
              `reason=${selectedItem.reasonCode}`,
            ]
          : []),
    ].join(' ');
    writeCliSummary(
      options.output,
      [
        { label: 'agent', style: 'target', value: result.agentId },
        { label: 'checkpoint', style: 'action', value: result.target },
        {
          label: 'scope',
          style: 'target',
          value: parsed.selector
            ? `${parsed.selector.repository}#${parsed.selector.number} (${parsed.selector.itemType})`
            : 'baseline',
        },
        { label: 'timeout', style: 'field', value: `${parsed.timeoutMs / 1_000}s` },
        {
          label: 'refresh',
          style: 'field',
          value: options.refresh ? 'requested' : 'not requested',
        },
        {
          label: 'status',
          style:
            result.status === 'completed'
              ? 'status'
              : result.status === 'timed-out'
                ? 'warning'
                : 'error',
          value: result.status === 'completed' ? 'checkpoint reached' : result.status,
        },
        { label: 'code', style: 'field', value: result.code },
        { label: 'last observed', style: 'field', value: observed },
      ],
      options.styles,
      { rowPadding: 0 },
    );
  }
  if (result.status !== 'completed') options.setExitCode(1);
}

export default presentCliCommand(waitNotificationsAgentSystem);
