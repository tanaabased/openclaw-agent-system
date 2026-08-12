import type GitHubNotificationMonitorService from '../channels/github/lib/monitor-service.ts';
import type AgentManifestService from '../lib/agent-manifest-service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliJson,
  writeCliSummary,
} from '../lib/cli-output.ts';
import { type Logger, reportManifestFailure } from '../lib/logger.ts';

export interface PollNotificationsAgentSystemOptions {
  agentId?: string;
  json: boolean;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  monitorService: Pick<GitHubNotificationMonitorService, 'runOnce'>;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
  workspaceDir: string;
}

/** Run the installed notification monitor once while retaining active failure backoff. */
export default async function pollNotificationsAgentSystem(
  options: PollNotificationsAgentSystemOptions,
): Promise<void> {
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
    forceInterval: true,
  });
  if (!result) {
    options.logger.error('github-notifications: manual poll returned no result');
    options.setExitCode(1);
    return;
  }

  if (options.json) {
    writeCliJson(options.output, result);
  } else {
    const counts = [
      ['approved', result.approved],
      ['rejected', result.rejected],
      ['duplicate', result.duplicates],
      ['retired', result.retired],
    ]
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .map(([label, value]) => `${label}=${value}`)
      .join(' ');
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
        ...(counts ? [{ label: 'items', style: 'field' as const, value: counts }] : []),
      ],
      options.styles,
    );
  }
  if (result.status !== 'completed') options.setExitCode(1);
}
