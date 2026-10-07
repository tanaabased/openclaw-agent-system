import type AgentManifestService from '../../../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliError,
  writeCliLines,
} from '../../../cli/output.ts';
import type { CommandLike } from '../../../cli/register.ts';
import { formatErrorDiagnostic } from '../../../core/logger.ts';
import type GitHubNotificationMonitorService from '../intake/monitor/service.ts';
import type GitHubNotificationStatusService from '../intake/monitor/status-service.ts';
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
  options: Pick<
    RegisterGitHubNotificationsCliOptions,
    'completeOneShot' | 'output' | 'setExitCode' | 'styles'
  > & { json?: boolean },
  failureCode: string,
): Promise<void> {
  let exitCode = 0;
  const setExitCode = (code: number) => {
    exitCode = Math.max(exitCode, code);
    options.setExitCode(exitCode);
  };
  try {
    await run(setExitCode);
  } catch (error) {
    writeCliError(
      options.output,
      formatErrorDiagnostic('github-notifications', error, failureCode),
      options,
    );
    setExitCode(1);
  } finally {
    await options.completeOneShot(exitCode);
  }
}

/** Register the GitHub channel's notification command subtree. */
export default function registerGitHubNotificationsCli(
  agentSystem: CommandLike,
  options: RegisterGitHubNotificationsCliOptions,
): void {
  const notifications = agentSystem
    .command('notifications')
    .description('manage github notification intake.')
    .action(() => writeHelp(notifications, options.output));
  const refresh = notifications
    .command('refresh')
    .description('run one github notification intake cycle now.')
    .option('--agent <id>', 'refresh notifications for an openclaw agent.')
    .option('--repository <owner/name>', 'select one github repository.')
    .option('--kind <issue|pull-request>', 'select one github item kind.')
    .option('--number <number>', 'select one github item number.')
    .option('--timeout <seconds>', 'set the bounded refresh timeout in seconds.')
    .option('--json', 'write structured json output.')
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
        { ...options, json: commandOptions.json === true },
        'github-notification-refresh-failed',
      );
    });
  const status = notifications
    .command('status')
    .description('inspect redacted github notification lifecycle state.')
    .option('--agent <id>', 'inspect notifications for an openclaw agent.')
    .option('--repository <owner/name>', 'select one github repository.')
    .option('--kind <issue|pull-request>', 'select one github item kind.')
    .option('--number <number>', 'select one github item number.')
    .option('--json', 'write structured json output.')
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
    .description('wait for a durable github notification lifecycle checkpoint.')
    .option('--agent <id>', 'wait on notifications for an openclaw agent.')
    .option('--repository <owner/name>', 'select one github repository.')
    .option('--kind <issue|pull-request>', 'select one github item kind.')
    .option('--number <number>', 'select one github item number.')
    .option('--for <target>', 'select the semantic lifecycle checkpoint.')
    .option('--refresh', 'run intake refresh cycles while waiting.')
    .option('--timeout <seconds>', 'set the bounded wait timeout in seconds.')
    .option('--json', 'write structured json output.')
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
        { ...options, json: commandOptions.json === true },
        'github-notification-wait-failed',
      );
    });
}
