import type { Readable } from 'node:stream';

import envAgentSystem from '../cli/env.ts';
import doctorAgentSystem from '../cli/doctor.ts';
import runAgentSystemTool from '../cli/tool.ts';
import setCredentialsAgentSystem from '../cli/credentials-set.ts';
import unsetCredentialsAgentSystem from '../cli/credentials-unset.ts';
import validateCredentialsAgentSystem from '../cli/credentials-validate.ts';
import installAgentSystem from '../cli/install.ts';
import refreshNotificationsAgentSystem from '../cli/notifications-refresh.ts';
import validateAgentSystem from '../cli/validate.ts';
import type GitHubNotificationMonitorService from '../channels/github/lib/monitor-service.ts';
import type AgentEnvironmentService from './agent-environment-service.ts';
import type AgentCommandAuthority from './agent-command-authority.ts';
import type AgentDoctorService from './agent-doctor-service.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type AgentInstallService from './agent-install-service.ts';
import { type CliOutput, type CliStyles, defaultCliOutput, writeCliLines } from './cli-output.ts';
import type { Logger } from './logger.ts';
import type OpCredentialManager from './op-credential-manager.ts';
import type OpCredentialInput from './op-credential-input.ts';
import type AgentSystemToolRegistry from './tool-registry.ts';
import type AgentSystemToolRuntime from './tool-runtime.ts';

type Action = (...args: unknown[]) => unknown;

export interface CommandLike {
  action(handler: Action): CommandLike;
  alias(name: string): CommandLike;
  command(specification: string): CommandLike;
  description(text: string): CommandLike;
  helpInformation(): string;
  option(flags: string, description: string): CommandLike;
  opts(): Record<string, unknown>;
}

export interface RegisterAgentSystemCliOptions {
  commandAuthority?: Pick<AgentCommandAuthority, 'resolve'>;
  cwd?: () => string;
  credentialInput: Pick<OpCredentialInput, 'read'>;
  credentialManager: Pick<OpCredentialManager, 'set' | 'unset' | 'validate'>;
  doctorService: Pick<AgentDoctorService, 'inspect'>;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  installService: Pick<AgentInstallService, 'install'>;
  input?: Readable;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  notificationMonitorService: Pick<GitHubNotificationMonitorService, 'runOnce'>;
  output?: CliOutput;
  toolRegistry: Pick<AgentSystemToolRegistry, 'invoke'>;
  toolRuntime: AgentSystemToolRuntime;
  setExitCode?: (code: number) => void;
  styles?: CliStyles;
}

function writeHelp(command: CommandLike, output: CliOutput): void {
  const help = command.helpInformation();
  writeCliLines(output, [help.endsWith('\n') ? help.slice(0, -1) : help]);
}

/** Register the plugin-owned command tree over the manifest service. */
export default function registerAgentSystemCli(
  program: CommandLike,
  options: RegisterAgentSystemCliOptions,
): void {
  const cwd = options.cwd ?? process.cwd;
  const commandAuthority = options.commandAuthority;
  const output = options.output ?? defaultCliOutput;
  const setExitCode = options.setExitCode ?? ((code: number) => (process.exitCode = code));
  const agentSystem = program
    .command('agent-system')
    .alias('as')
    .description('Manage reproducible OpenClaw agent workspaces.')
    .action(() => writeHelp(agentSystem, output));
  const validate = agentSystem
    .command('validate')
    .description('Discover and validate the workspace Agent System manifest.')
    .option('--agent <id>', 'Validate the configured workspace for an OpenClaw agent.')
    .option('--json', 'Write structured JSON output.')
    .action(async () => {
      const commandOptions = validate.opts();
      const agentId = commandOptions.agent;
      await validateAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        json: commandOptions.json === true,
        logger: options.logger,
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        workspaceDir: cwd(),
      });
    });
  const env = agentSystem
    .command('env')
    .description('Inspect the resolved Agent System environment without showing values.')
    .option('--agent <id>', 'Inspect the configured workspace for an OpenClaw agent.')
    .option('--json', 'Write structured JSON output.')
    .action(async () => {
      const commandOptions = env.opts();
      const agentId = commandOptions.agent;
      await envAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        environmentService: options.environmentService,
        json: commandOptions.json === true,
        logger: options.logger,
        output,
        setExitCode,
        styles: options.styles,
        workspaceDir: cwd(),
      });
    });
  const doctor = agentSystem
    .command('doctor')
    .description('Inspect Agent System agent, path, and configured capability drift.')
    .option('--agent <id>', 'Inspect the configured workspace for an OpenClaw agent.')
    .option('--json', 'Write structured JSON output.')
    .action(async () => {
      const commandOptions = doctor.opts();
      const agentId = commandOptions.agent;
      await doctorAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        doctorService: options.doctorService,
        json: commandOptions.json === true,
        logger: options.logger,
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        workspaceDir: cwd(),
      });
    });
  const notifications = agentSystem
    .command('notifications')
    .description('Manage GitHub notification intake.')
    .action(() => writeHelp(notifications, output));
  const notificationsRefresh = notifications
    .command('refresh')
    .description('Run one GitHub notification intake cycle now.')
    .option('--agent <id>', 'Refresh notifications for an OpenClaw agent.')
    .option('--json', 'Write structured JSON output.')
    .action(async () => {
      const commandOptions = notificationsRefresh.opts();
      const agentId = commandOptions.agent;
      await refreshNotificationsAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        json: commandOptions.json === true,
        logger: options.logger,
        manifestService: options.manifestService,
        monitorService: options.notificationMonitorService,
        output,
        setExitCode,
        styles: options.styles,
        workspaceDir: cwd(),
      });
    });
  const tool = agentSystem
    .command('tool <command> [args...]')
    .description('Run one registered command through its Agent System tool.')
    .option('--agent <id>', 'Use the configured workspace for an OpenClaw agent.')
    .action(async (command, args) => {
      const agentId = tool.opts().agent;
      await runAgentSystemTool({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        argv: Array.isArray(args) ? args.map(String) : [],
        command: String(command),
        ...(options.input ? { input: options.input } : {}),
        logger: options.logger,
        output,
        ...(commandAuthority
          ? {
              resolveCommandBinding: (
                environment: Readonly<NodeJS.ProcessEnv>,
                workspaceDir: string,
              ) => commandAuthority.resolve(environment, workspaceDir),
            }
          : {}),
        setExitCode,
        ...(process.stdout.isTTY && process.stdout.columns > 0
          ? { terminalColumns: process.stdout.columns }
          : {}),
        toolRegistry: options.toolRegistry,
        toolRuntime: options.toolRuntime,
        workspaceDir: cwd(),
      });
    });
  const credentials = agentSystem
    .command('credentials')
    .description('Manage agent-scoped environment-provider credentials.')
    .action(() => writeHelp(credentials, output));
  const credentialsSet = credentials
    .command('set <credential>')
    .description('Validate and store an agent-scoped credential.')
    .option('--agent <id>', 'Use the configured workspace for an OpenClaw agent.')
    .option('--store <id>', 'Write to one exact credential store.')
    .option('--from-env', 'Read OP_SERVICE_ACCOUNT_TOKEN from the process environment.')
    .option('--stdin', 'Read the credential from standard input.')
    .action(async (credential) => {
      const commandOptions = credentialsSet.opts();
      const agentId = commandOptions.agent;
      const storeId = commandOptions.store;
      await setCredentialsAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        credential: String(credential),
        credentialInput: options.credentialInput,
        credentialManager: options.credentialManager,
        fromEnvironment: commandOptions.fromEnv === true,
        fromStdin: commandOptions.stdin === true,
        logger: options.logger,
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        ...(typeof storeId === 'string' ? { storeId } : {}),
        workspaceDir: cwd(),
      });
    });
  const credentialsValidate = credentials
    .command('validate <credential>')
    .description('Validate a credential against the current manifest.')
    .option('--agent <id>', 'Use the configured workspace for an OpenClaw agent.')
    .option('--store <id>', 'Validate one exact credential store.')
    .option('--from-env', 'Validate OP_SERVICE_ACCOUNT_TOKEN from the process environment.')
    .action(async (credential) => {
      const commandOptions = credentialsValidate.opts();
      const agentId = commandOptions.agent;
      const storeId = commandOptions.store;
      await validateCredentialsAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        credential: String(credential),
        credentialManager: options.credentialManager,
        fromEnvironment: commandOptions.fromEnv === true,
        logger: options.logger,
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        ...(typeof storeId === 'string' ? { storeId } : {}),
        workspaceDir: cwd(),
      });
    });
  const credentialsUnset = credentials
    .command('unset <credential>')
    .description('Remove an agent-scoped credential from persistent storage.')
    .option('--agent <id>', 'Use the configured workspace for an OpenClaw agent.')
    .option('--store <id>', 'Remove from one exact credential store.')
    .action(async (credential) => {
      const commandOptions = credentialsUnset.opts();
      const agentId = commandOptions.agent;
      const storeId = commandOptions.store;
      await unsetCredentialsAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        credential: String(credential),
        credentialManager: options.credentialManager,
        logger: options.logger,
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        ...(typeof storeId === 'string' ? { storeId } : {}),
        workspaceDir: cwd(),
      });
    });
  const install = agentSystem
    .command('install')
    .description('Install the workspace agent and reconcile configured lifecycle state.')
    .option('--json', 'Write structured JSON output.')
    .action(async () => {
      await installAgentSystem({
        installService: options.installService,
        json: install.opts().json === true,
        logger: options.logger,
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        workspaceDir: cwd(),
      });
    });
}
