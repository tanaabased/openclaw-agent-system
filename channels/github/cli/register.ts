import type AgentManifestService from '../../../lib/agent-manifest-service.ts';
import { type CliOutput, type CliStyles, writeCliLines } from '../../../lib/cli-output.ts';
import type { CommandLike } from '../../../lib/register-cli.ts';
import type GitHubNotificationMonitorService from '../lib/monitor-service.ts';
import type GitHubNotificationStatusService from '../lib/status-service.ts';
import refreshNotificationsAgentSystem from './refresh.ts';
import statusNotificationsAgentSystem from './status.ts';
import waitNotificationsAgentSystem from './wait.ts';

export interface RegisterGitHubNotificationsCliOptions {
  completeOneShot(code: number): Promise<void>;
  cwd(): string;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  monitorService: Pick<GitHubNotificationMonitorService, 'runOnce'>;
  output: CliOutput;
  setExitCode(code: number): void;
  statusService: Pick<GitHubNotificationStatusService, 'inspect' | 'wait'>;
  styles?: CliStyles;
}

function writeHelp(command: CommandLike, output: CliOutput): void {
  const help = command.helpInformation();
  writeCliLines(output, [help.endsWith('\n') ? help.slice(0, -1) : help]);
}

async function runOneShot(
  run: (setExitCode: (code: number) => void) => Promise<void>,
  options: Pick<RegisterGitHubNotificationsCliOptions, 'completeOneShot' | 'setExitCode'>,
): Promise<void> {
  let exitCode = 0;
  await run((code) => {
    exitCode = Math.max(exitCode, code);
    options.setExitCode(code);
  });
  await options.completeOneShot(exitCode);
}

/** Register the GitHub channel's notification command subtree. */
export default function registerGitHubNotificationsCli(
  agentSystem: CommandLike,
  options: RegisterGitHubNotificationsCliOptions,
): void {
  const notifications = agentSystem
    .command('notifications')
    .description('Manage GitHub notification intake.')
    .action(() => writeHelp(notifications, options.output));
  const refresh = notifications
    .command('refresh')
    .description('Run one GitHub notification intake cycle now.')
    .option('--agent <id>', 'Refresh notifications for an OpenClaw agent.')
    .option('--repository <owner/name>', 'Select one GitHub repository.')
    .option('--kind <issue|pull-request>', 'Select one GitHub item kind.')
    .option('--number <number>', 'Select one GitHub item number.')
    .option('--timeout <seconds>', 'Set the bounded refresh timeout in seconds.')
    .option('--json', 'Write structured JSON output.')
    .action(async () => {
      const commandOptions = refresh.opts();
      const agentId = commandOptions.agent;
      await runOneShot(
        (setExitCode) =>
          refreshNotificationsAgentSystem({
            ...(typeof agentId === 'string' ? { agentId } : {}),
            itemKind: commandOptions.kind,
            itemNumber: commandOptions.number,
            json: commandOptions.json === true,
            manifestService: options.manifestService,
            monitorService: options.monitorService,
            output: options.output,
            repository: commandOptions.repository,
            setExitCode,
            styles: options.styles,
            timeoutSeconds: commandOptions.timeout,
            workspaceDir: options.cwd(),
          }),
        options,
      );
    });
  const status = notifications
    .command('status')
    .description('Inspect redacted GitHub notification lifecycle state.')
    .option('--agent <id>', 'Inspect notifications for an OpenClaw agent.')
    .option('--repository <owner/name>', 'Select one GitHub repository.')
    .option('--kind <issue|pull-request>', 'Select one GitHub item kind.')
    .option('--number <number>', 'Select one GitHub item number.')
    .option('--json', 'Write structured JSON output.')
    .action(async () => {
      const commandOptions = status.opts();
      const agentId = commandOptions.agent;
      await statusNotificationsAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        itemKind: commandOptions.kind,
        itemNumber: commandOptions.number,
        json: commandOptions.json === true,
        manifestService: options.manifestService,
        output: options.output,
        repository: commandOptions.repository,
        setExitCode: options.setExitCode,
        statusService: options.statusService,
        styles: options.styles,
        workspaceDir: options.cwd(),
      });
    });
  const wait = notifications
    .command('wait')
    .description('Wait for a durable GitHub notification lifecycle checkpoint.')
    .option('--agent <id>', 'Wait on notifications for an OpenClaw agent.')
    .option('--repository <owner/name>', 'Select one GitHub repository.')
    .option('--kind <issue|pull-request>', 'Select one GitHub item kind.')
    .option('--number <number>', 'Select one GitHub item number.')
    .option('--for <target>', 'Select the semantic lifecycle checkpoint.')
    .option('--refresh', 'Run intake refresh cycles while waiting.')
    .option('--timeout <seconds>', 'Set the bounded wait timeout in seconds.')
    .option('--json', 'Write structured JSON output.')
    .action(async () => {
      const commandOptions = wait.opts();
      const agentId = commandOptions.agent;
      await runOneShot(
        (setExitCode) =>
          waitNotificationsAgentSystem({
            ...(typeof agentId === 'string' ? { agentId } : {}),
            itemKind: commandOptions.kind,
            itemNumber: commandOptions.number,
            json: commandOptions.json === true,
            manifestService: options.manifestService,
            output: options.output,
            refresh: commandOptions.refresh === true,
            repository: commandOptions.repository,
            setExitCode,
            statusService: options.statusService,
            styles: options.styles,
            target: commandOptions.for,
            timeoutSeconds: commandOptions.timeout,
            workspaceDir: options.cwd(),
          }),
        options,
      );
    });
}
