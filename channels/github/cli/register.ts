import type OpenClawNotifications from '../../../agent/openclaw-notifications.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliError,
  writeCliLines,
} from '../../../cli/output.ts';
import type { CommandLike } from '../../../cli/register.ts';
import presentCliCommand from '../../../cli/presentation.ts';
import { formatRedactedErrorDiagnostic } from '../../../core/logger.ts';
import refreshNotificationsAgentSystem from './refresh.ts';
import statusNotificationsAgentSystem from './status.ts';
import waitNotificationsAgentSystem from './wait.ts';
import resetNotificationsCommand, { type ResetNotificationsOptions } from './reset.ts';

export interface RegisterGitHubNotificationsCliOptions {
  nativeService?: Pick<OpenClawNotifications, 'inspect' | 'refresh' | 'wait'>;
  completeOneShot(code: number): Promise<void>;
  cwd(): string;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
  terminalColumns?: number;
  reset?: Pick<ResetNotificationsOptions, 'service' | 'listAgents' | 'input' | 'environment'>;
  allowOperatorCommand?(json: boolean): Promise<boolean>;
}

function writeHelp(command: CommandLike, output: CliOutput): void {
  const help = command.helpInformation();
  writeCliLines(output, [help.endsWith('\n') ? help.slice(0, -1) : help]);
}

async function runOneShot(
  options: Pick<
    RegisterGitHubNotificationsCliOptions,
    'completeOneShot' | 'output' | 'setExitCode' | 'styles' | 'terminalColumns'
  > & { json?: boolean },
  run: (setExitCode: (code: number) => void, output: CliOutput) => Promise<void>,
  failureCode: string,
): Promise<void> {
  let exitCode = 0;
  try {
    await presentCliCommand(async (presented: typeof options) => {
      const setExitCode = (code: number) => {
        exitCode = Math.max(exitCode, code);
        presented.setExitCode(exitCode);
      };
      try {
        await run(setExitCode, presented.output);
      } catch (error) {
        const resetCode =
          failureCode === 'notification-reset-failed' &&
          error instanceof Error &&
          /^notification-reset-[a-z-]+$/u.test(error.message)
            ? error.message
            : undefined;
        const invalid =
          resetCode &&
          [
            'notification-reset-target-conflict',
            'notification-reset-agent-unknown',
            'notification-reset-requires-explicit-target-and-yes',
          ].includes(resetCode);
        writeCliError(
          presented.output,
          resetCode
            ? `${resetCode}: ${invalid ? 'select agents with repeated --agent or --all; unattended reset also requires --yes' : 'inspect the reset scope and retry the same command; preserve any recovery record'}`
            : formatRedactedErrorDiagnostic('github-notifications', error, failureCode),
          presented,
        );
        setExitCode(invalid ? 2 : 1);
      }
    })(options);
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
  const reset = notifications
    .command('reset')
    .description('reset notification management, optionally purging owned resources.')
    .addOption(
      agentSystem
        .createOption('--agent <id>', 'select an agent; repeat for multiple agents.')
        .argParser((value: string, previous: string[] = []) => [...previous, value]),
    )
    .option('--all', 'select all configured agents.')
    .option(
      '--fresh',
      'restart interrupted reset checks, retaining cleanup inventory and native receipts.',
    )
    .option(
      '--purge',
      'also archive managed issue chats and remove managed checkouts; leave github unchanged.',
    )
    .option('--preview', 'preview the explicit selection without changing state.')
    .option(
      '--confirmation <digest>',
      'require the previously previewed selection to remain unchanged.',
    )
    .option('--yes', 'confirm the explicit selection without prompting.')
    .option(
      '--json',
      'write structured json output; requires explicit targets and --preview or --yes.',
    )
    .action(async () => {
      const values = reset.opts();
      const json = values.json === true;
      if (!options.allowOperatorCommand || !(await options.allowOperatorCommand(json))) return;
      await runOneShot(
        { ...options, json },
        async (setExitCode, output) => {
          if (!options.reset) throw new Error('notification-reset-unavailable');
          await resetNotificationsCommand({
            ...options.reset,
            agents: Array.isArray(values.agent) ? values.agent : [],
            all: values.all === true,
            purge: values.purge === true,
            fresh: values.fresh === true,
            yes: values.yes === true,
            preview: values.preview === true,
            confirmation: typeof values.confirmation === 'string' ? values.confirmation : undefined,
            json,
            manifestService: options.manifestService,
            workspaceDir: options.cwd(),
            output,
            styles: options.styles,
            terminalColumns: options.terminalColumns,
            setExitCode,
          });
        },
        'notification-reset-failed',
      );
    });
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
        { ...options, json: commandOptions.json === true },
        (setExitCode, output) =>
          refreshNotificationsAgentSystem({
            ...(typeof agentId === 'string' ? { agentId } : {}),
            itemKind: commandOptions.kind,
            itemNumber: commandOptions.number,
            json: commandOptions.json === true,
            manifestService: options.manifestService,
            nativeService: options.nativeService,
            output,
            repository: commandOptions.repository,
            setExitCode,
            styles: options.styles,
            timeoutSeconds: commandOptions.timeout,
            workspaceDir: options.cwd(),
          }),
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
        nativeService: options.nativeService,
        output: options.output,
        repository: commandOptions.repository,
        setExitCode: options.setExitCode,
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
        { ...options, json: commandOptions.json === true },
        (setExitCode, output) =>
          waitNotificationsAgentSystem({
            ...(typeof agentId === 'string' ? { agentId } : {}),
            itemKind: commandOptions.kind,
            itemNumber: commandOptions.number,
            json: commandOptions.json === true,
            manifestService: options.manifestService,
            nativeService: options.nativeService,
            output,
            refresh: commandOptions.refresh === true,
            repository: commandOptions.repository,
            setExitCode,
            styles: options.styles,
            target: commandOptions.for,
            timeoutSeconds: commandOptions.timeout,
            terminalColumns: options.terminalColumns,
            workspaceDir: options.cwd(),
          }),
        'github-notification-wait-failed',
      );
    });
}
