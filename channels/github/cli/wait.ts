import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnostics,
  writeCliError,
  writeCliJson,
  writeCliSummary,
} from '../../../lib/cli-output.ts';
import { formatManifestFailure } from '../../../lib/logger.ts';
import type GitHubNotificationStatusService from '../lib/status-service.ts';
import {
  githubNotificationWaitTargets,
  type GitHubNotificationWaitTarget,
} from '../utils/monitor-status.ts';
import {
  NotificationCliOptionError,
  notificationItemSelector,
  notificationPositiveInteger,
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
      : notificationPositiveInteger(options.timeoutSeconds, 'timeout');
  return { selector, target, timeoutMs: timeoutSeconds * 1_000 };
}

/** Wait for one semantic notification checkpoint with optional one-shot intake refresh. */
export default async function waitNotificationsAgentSystem(
  options: WaitNotificationsAgentSystemOptions,
): Promise<void> {
  let parsed;
  try {
    parsed = waitOptions(options);
  } catch (error) {
    writeCliError(
      options.output,
      `github-notifications: invalid wait options code=github-notification-wait-options-invalid message=${error instanceof NotificationCliOptionError ? error.message : 'unknown'}`,
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

  const result = await options.statusService.wait({
    agentId: manifest.manifest.agent.id,
    executionSurface: 'cli-one-shot',
    refresh: options.refresh,
    ...(parsed.selector === undefined ? {} : { selector: parsed.selector }),
    target: parsed.target,
    timeoutMs: parsed.timeoutMs,
  });
  if (options.json) {
    writeCliJson(options.output, result);
  } else {
    writeCliSummary(
      options.output,
      [
        { label: 'agent', style: 'target', value: result.agentId },
        { label: 'target', style: 'field', value: result.target },
        {
          label: 'status',
          style: result.status === 'completed' ? 'status' : 'error',
          value: result.status,
        },
        { label: 'code', style: 'field', value: result.code },
      ],
      options.styles,
    );
  }
  if (result.status !== 'completed') options.setExitCode(1);
}
