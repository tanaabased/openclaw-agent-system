import type { Readable } from 'node:stream';
import type { Option } from 'commander';

import executeAutomation from './automation-execute.ts';
import automationList from './automation-list.ts';
import automationRun from './automation-run.ts';
import automationRuns from './automation-runs.ts';
import automationSync from './automation-sync.ts';
import type AutomationService from '../agent/automation-service.ts';
import type BoundCommandService from '../agent/bound-command-service.ts';

import envAgentSystem from './env.ts';
import credentialsCache, { type OpCacheGatewayRequest } from './credentials-cache.ts';
import doctorAgentSystem from './doctor.ts';
import runAgentSystemTool from './tool.ts';
import setCredentialsAgentSystem from './credentials-set.ts';
import unsetCredentialsAgentSystem from './credentials-unset.ts';
import validateCredentialsAgentSystem from './credentials-validate.ts';
import installAgentSystem from './install.ts';
import validateAgentSystem from './validate.ts';
import backupCreate from './backup-create.ts';
import backupVerify from './backup-verify.ts';
import backupPrune from './backup-prune.ts';
import backupRestore from './backup-restore.ts';
import WorkspaceBackupService from '../agent/backup-service.ts';
import registerGitHubNotificationsCli from '../channels/github/cli/register.ts';
import type GitHubNotificationMonitorService from '../channels/github/intake/monitor/service.ts';
import type GitHubNotificationStatusService from '../channels/github/intake/monitor/status-service.ts';
import type AgentEnvironmentService from '../environment/service.ts';
import {
  type default as AgentCommandAuthority,
  agentCommandAuthorityEnvironmentName,
  agentCommandCapabilityEnvironmentName,
} from '../agent/command-authority.ts';
import type AgentDoctorService from '../agent/doctor-service.ts';
import type AgentManifestService from '../manifest/service.ts';
import type AgentInstallService from '../agent/install-service.ts';
import { completeCliOneShot } from './one-shot.ts';
import {
  type CliOutput,
  type CliStyles,
  defaultCliOutput,
  writeCliError,
  writeCliLines,
} from './output.ts';
import type OpCredentialManager from '../credentials/op-manager.ts';
import type OpCredentialInput from '../credentials/op-input.ts';
import type AgentSystemToolRegistry from '../api/registry.ts';
import type AgentSystemToolRuntime from '../api/runtime.ts';

type Action = (...args: unknown[]) => unknown;

export interface CommandLike {
  action(handler: Action): CommandLike;
  addOption(option: Option): CommandLike;
  alias(name: string): CommandLike;
  command(specification: string, options?: { hidden?: boolean }): CommandLike;
  createOption(flags: string, description?: string): Option;
  description(text: string): CommandLike;
  helpInformation(): string;
  option(flags: string, description: string): CommandLike;
  opts(): Record<string, unknown>;
}

export interface RegisterAgentSystemCliOptions {
  automations?: AutomationService;
  boundCommands?: BoundCommandService;
  backupService?: WorkspaceBackupService;
  commandAuthority?: Pick<AgentCommandAuthority, 'resolve' | 'classify'>;
  cacheGatewayRequest?: OpCacheGatewayRequest;
  completeOneShot?: (code: number) => Promise<void>;
  cwd?: () => string;
  credentialInput: Pick<OpCredentialInput, 'read'>;
  credentialManager: Pick<OpCredentialManager, 'set' | 'unset' | 'validate'>;
  doctorService: Pick<AgentDoctorService, 'inspect'>;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  installService: Pick<AgentInstallService, 'install'>;
  input?: Readable;
  environment?: Readonly<NodeJS.ProcessEnv>;
  setupPrompt?: () => Promise<boolean | symbol>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  notificationMonitorService: Pick<GitHubNotificationMonitorService, 'runOnce'>;
  notificationStatusService: Pick<GitHubNotificationStatusService, 'inspect' | 'wait'>;
  output?: CliOutput;
  toolRegistry: Pick<AgentSystemToolRegistry, 'invoke' | 'hostFallback'>;
  toolRuntime: AgentSystemToolRuntime;
  setExitCode?: (code: number) => void;
  styles?: CliStyles;
  terminalColumns?: number;
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
  const completeOneShot = options.completeOneShot ?? completeCliOneShot;
  const output = options.output ?? defaultCliOutput;
  const setExitCode = options.setExitCode ?? ((code: number) => (process.exitCode = code));
  const environment = options.environment ?? process.env;
  const allowOperatorCommand = async (json = false) => {
    try {
      const binding = await commandAuthority?.resolve(environment, cwd());
      if (
        !binding &&
        !environment[agentCommandAuthorityEnvironmentName] &&
        !environment[agentCommandCapabilityEnvironmentName] &&
        !(environment.CODEX_THREAD_ID && environment.OPENCLAW_STATE_DIR)
      )
        return true;
    } catch {
      // Invalid authority must not downgrade an agent descendant to an operator.
    }
    writeCliError(
      output,
      'agent system operator commands are unavailable to agent or setup descendants.',
      { json, styles: options.styles, terminalColumns: options.terminalColumns },
    );
    setExitCode(1);
    return false;
  };
  const agentSystem = program
    .command('agent-system')
    .alias('as')
    .description('manage reproducible openclaw agent workspaces.')
    .action(() => writeHelp(agentSystem, output));
  if (options.automations) {
    const automations = agentSystem
      .command('automations')
      .description('list, synchronize, run, and inspect owned repository automations.')
      .action(() => writeHelp(automations, output));
    for (const action of ['list', 'sync', 'run', 'runs'] as const) {
      const command = automations
        .command(action === 'run' || action === 'runs' ? `${action} <id>` : action)
        .description(
          {
            list: 'inspect declared and native state without applying changes.',
            sync: 'reconcile owned automations using the install lifecycle.',
            run: 'queue one enabled synchronized job by manifest id.',
            runs: 'read native execution and delivery history by manifest id.',
          }[action],
        )
        .option('--agent <id>', 'select an installed agent (operators only).')
        .option('--json', 'write one structured json result.');
      if (action === 'runs')
        command
          .addOption(
            command
              .createOption('--limit <count>', 'maximum history entries, from 1 to 200.')
              .default('50'),
          )
          .addOption(
            command.createOption('--offset <count>', 'history entries to skip.').default('0'),
          )
          .option('--run-id <id>', 'filter by the native occurrence id.');
      command.action(async (...args: unknown[]) => {
        if (!(await allowOperatorCommand(command.opts().json === true))) return;
        const selected = command.opts();
        const common = {
          ...(typeof selected.agent === 'string' ? { agentId: selected.agent } : {}),
          automations: options.automations!,
          styles: options.styles,
          terminalColumns: options.terminalColumns,
          manifestService: options.manifestService,
          json: selected.json === true,
          output,
          setExitCode,
          workspaceDir: cwd(),
        };
        if (action === 'list') await automationList(common);
        else if (action === 'sync') await automationSync(common);
        else if (action === 'run') await automationRun(common, String(args[0]));
        else
          await automationRuns(common, String(args[0]), {
            limit: /^\d+$/u.test(String(selected.limit)) ? Number(selected.limit) : NaN,
            offset: /^\d+$/u.test(String(selected.offset)) ? Number(selected.offset) : NaN,
            ...(typeof selected.runId === 'string' ? { runId: selected.runId } : {}),
          });
      });
    }
  }
  if (options.automations && options.boundCommands) {
    const execute = agentSystem
      .command('automation-execute', { hidden: true })
      .description('execute one synchronized owned automation (scheduler entrypoint).')
      .option('--id <id>', 'select the owned manifest automation id.')
      .option('--hash <hash>', 'require the synchronized effective content hash.')
      .action(async () => {
        if (!(await allowOperatorCommand(true))) return completeOneShot(1);
        const args = execute.opts();
        if (
          typeof args.id !== 'string' ||
          typeof args.hash !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(args.hash)
        ) {
          output.writeStderr('automation execution requires an owned id and synchronized hash.\n');
          return completeOneShot(1);
        }
        const code = await executeAutomation({
          id: args.id,
          hash: args.hash,
          workspaceDir: cwd(),
          manifestService: options.manifestService,
          automations: options.automations!,
          commands: options.boundCommands!,
          output,
        });
        setExitCode(code);
        await completeOneShot(code);
      });
  }
  const backupService = options.backupService ?? new WorkspaceBackupService();
  const backup = agentSystem
    .command('backup')
    .description('create, verify, prune, and restore private per-agent recovery archives.')
    .action(() => writeHelp(backup, output));
  const create = backup
    .command('create')
    .description('capture selected workspace files and optional openclaw agent state.')
    .option('--agent <id>', 'select an installed agent (operators only).')
    .option('--output <directory>', 'override the manifest backup destination.')
    .addOption(
      backup
        .createOption('--openclaw-state <mode>', 'capture agent state: auto, required, or off.')
        .choices(['auto', 'required', 'off']),
    )
    .option('--dry-run', 'preview effective settings and selected files without writing.')
    .option('--json', 'write one structured json result.')
    .addOption(
      backup
        .createOption('--git-ignore [boolean]', 'apply git-ignore rules; true or false.')
        .choices(['true', 'false'])
        .preset('true'),
    );
  for (const name of ['include', 'exclude']) {
    create.addOption(
      backup
        .createOption(
          `--${name} <patterns...>`,
          `replace the manifest ${name} list; repeatable, use --${name}= to clear.`,
        )
        .argParser((value: string, previous: string[] | undefined) => [
          ...(previous ?? []),
          ...(value === '' ? [] : [value]),
        ]),
    );
  }
  create.action(async () => {
    const selected = create.opts();
    await backupCreate({
      ...(typeof selected.agent === 'string' ? { agentId: selected.agent } : {}),
      commandAuthority,
      environment,
      manifestService: options.manifestService,
      workspaceDir: cwd(),
      service: backupService,
      output,
      setExitCode,
      styles: options.styles,
      json: selected.json === true,
      dryRun: selected.dryRun === true,
      overrides: {
        ...(typeof selected.output === 'string' ? { output: selected.output } : {}),
        ...(selected.gitIgnore === undefined ? {} : { gitIgnore: selected.gitIgnore === 'true' }),
        ...(selected.openclawState === 'auto' ||
        selected.openclawState === 'required' ||
        selected.openclawState === 'off'
          ? { openclawState: selected.openclawState }
          : {}),
        ...(Array.isArray(selected.include) ? { include: selected.include.map(String) } : {}),
        ...(Array.isArray(selected.exclude) ? { exclude: selected.exclude.map(String) } : {}),
      },
    });
  });
  const prune = backup
    .command('prune')
    .description('retain the newest local backups by embedded capture time.')
    .option('--agent <id>', 'select an installed agent (operators only).')
    .option('--output <directory>', 'override the manifest backup destination.')
    .option('--keep <count>', 'required positive integer number of backups to retain.')
    .option('--dry-run', 'preview without deleting or creating state.')
    .option('--json', 'write one structured json result.')
    .action(async () => {
      const selected = prune.opts();
      await backupPrune({
        ...(typeof selected.agent === 'string' ? { agentId: selected.agent } : {}),
        ...(typeof selected.output === 'string' ? { destination: selected.output } : {}),
        keep: typeof selected.keep === 'string' ? selected.keep : undefined,
        commandAuthority,
        environment,
        manifestService: options.manifestService,
        workspaceDir: cwd(),
        service: backupService,
        output,
        setExitCode,
        styles: options.styles,
        json: selected.json === true,
        dryRun: selected.dryRun === true,
        terminalColumns:
          options.terminalColumns ?? (process.stdout.isTTY ? process.stdout.columns : undefined),
      });
    });
  const verifyArchive = backup
    .command('verify <archive>')
    .description('check archive structure, inventory and checksums without extraction.')
    .option('--agent <id>', 'require this archive agent identity (operators only).')
    .option('--json', 'write one structured json result.')
    .action(async (archive) => {
      const selected = verifyArchive.opts();
      await backupVerify({
        ...(typeof selected.agent === 'string' ? { agentId: selected.agent } : {}),
        archive: String(archive),
        commandAuthority,
        environment,
        manifestService: options.manifestService,
        workspaceDir: cwd(),
        service: backupService,
        output,
        setExitCode,
        styles: options.styles,
        json: selected.json === true,
      });
    });
  const restore = backup
    .command('restore <archive>')
    .description(
      'recover a verified archive into a fresh private staging directory (operators only).',
    )
    .option('--target <directory>', 'required fresh recovery directory; never a live agent path.')
    .option('--agent <id>', 'require this recorded agent identity.')
    .option('--json', 'write one structured json result.')
    .action(async (archive) => {
      const selected = restore.opts();
      await backupRestore({
        ...(typeof selected.agent === 'string' ? { agentId: selected.agent } : {}),
        archive: String(archive),
        target: typeof selected.target === 'string' ? selected.target : '',
        commandAuthority,
        environment,
        manifestService: options.manifestService,
        workspaceDir: cwd(),
        service: backupService,
        output,
        setExitCode,
        styles: options.styles,
        json: selected.json === true,
      });
    });
  const validate = agentSystem
    .command('validate')
    .description('discover and validate the workspace agent system manifest.')
    .option('--agent <id>', 'validate the configured workspace for an openclaw agent.')
    .option('--json', 'write structured json output.')
    .action(async () => {
      const commandOptions = validate.opts();
      const agentId = commandOptions.agent;
      await validateAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        json: commandOptions.json === true,
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        workspaceDir: cwd(),
      });
    });
  const env = agentSystem
    .command('env')
    .description('inspect the resolved agent system environment without showing values.')
    .option('--agent <id>', 'inspect the configured workspace for an openclaw agent.')
    .option('--json', 'write structured json output.')
    .action(async () => {
      const commandOptions = env.opts();
      const agentId = commandOptions.agent;
      await envAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        environmentService: options.environmentService,
        json: commandOptions.json === true,
        output,
        setExitCode,
        styles: options.styles,
        workspaceDir: cwd(),
      });
    });
  const doctor = agentSystem
    .command('doctor')
    .alias('status')
    .description('inspect agent system agent, path, and configured capability drift.')
    .option('--agent <id>', 'inspect the configured workspace for an openclaw agent.')
    .option('--json', 'write structured json output.')
    .action(async () => {
      if (!(await allowOperatorCommand(doctor.opts().json === true))) return;
      const commandOptions = doctor.opts();
      const agentId = commandOptions.agent;
      await doctorAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        doctorService: options.doctorService,
        json: commandOptions.json === true,
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        terminalColumns:
          options.terminalColumns ?? (process.stdout.isTTY ? process.stdout.columns : undefined),
        workspaceDir: cwd(),
      });
    });
  registerGitHubNotificationsCli(agentSystem, {
    completeOneShot,
    cwd,
    manifestService: options.manifestService,
    monitorService: options.notificationMonitorService,
    output,
    setExitCode,
    statusService: options.notificationStatusService,
    styles: options.styles,
  });
  const tool = agentSystem
    .command('tool <command> [args...]')
    .description('run one registered command through its agent system tool.')
    .option('--agent <id>', 'use the configured workspace for an openclaw agent.')
    .addOption(agentSystem.createOption('--shim [mode]').hideHelp())
    .action(async (command, args) => {
      const agentId = tool.opts().agent;
      const shim = tool.opts().shim;
      if (shim !== undefined && shim !== 'managed' && shim !== 'contextual') {
        writeCliError(output, 'invalid internal launcher invocation.', options);
        setExitCode(1);
        return;
      }
      await runAgentSystemTool({
        invocationMode: shim ?? 'operator',
        manifestService: options.manifestService,
        ...(commandAuthority
          ? {
              resolveCommandContext: (environment, workspaceDir) =>
                commandAuthority.classify(environment, workspaceDir),
            }
          : {}),
        ...(typeof agentId === 'string' ? { agentId } : {}),
        argv: Array.isArray(args) ? args.map(String) : [],
        command: String(command),
        ...(options.input ? { input: options.input } : {}),
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
    .description('manage agent-scoped environment-provider credentials.')
    .action(() => writeHelp(credentials, output));
  const cache = credentials
    .command('cache')
    .description('inspect or flush the running gateway op cache.')
    .action(() => writeHelp(cache, output));
  for (const action of ['status', 'flush'] as const) {
    const command = cache
      .command(action)
      .description(`${action === 'status' ? 'inspect' : 'flush'} the running gateway op cache.`)
      .option('--json', 'write structured json output.')
      .action(async () => {
        if (!(await allowOperatorCommand(command.opts().json === true))) return;
        const agentId = command.opts().agent;
        await credentialsCache({
          action,
          json: command.opts().json === true,
          ...(typeof agentId === 'string' ? { agentId } : {}),
          output,
          styles: options.styles,
          setExitCode,
          ...(options.cacheGatewayRequest ? { request: options.cacheGatewayRequest } : {}),
        });
      });
    if (action === 'flush') command.option('--agent <id>', 'select an agent for invalidation.');
  }
  const credentialsSet = credentials
    .command('set <credential>')
    .description('validate and store an agent-scoped credential.')
    .option('--agent <id>', 'use the configured workspace for an openclaw agent.')
    .option('--store <id>', 'write to one exact credential store.')
    .option('--from-env', 'read OP_SERVICE_ACCOUNT_TOKEN from the process environment.')
    .option('--stdin', 'read the credential from standard input.')
    .action(async (credential) => {
      if (!(await allowOperatorCommand())) return;
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
    .description('validate a credential against the current manifest.')
    .option('--agent <id>', 'use the configured workspace for an openclaw agent.')
    .option('--store <id>', 'validate one exact credential store.')
    .option('--from-env', 'validate OP_SERVICE_ACCOUNT_TOKEN from the process environment.')
    .action(async (credential) => {
      if (!(await allowOperatorCommand())) return;
      const commandOptions = credentialsValidate.opts();
      const agentId = commandOptions.agent;
      const storeId = commandOptions.store;
      await validateCredentialsAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        credential: String(credential),
        credentialManager: options.credentialManager,
        fromEnvironment: commandOptions.fromEnv === true,
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
    .description('remove an agent-scoped credential from persistent storage.')
    .option('--agent <id>', 'use the configured workspace for an openclaw agent.')
    .option('--store <id>', 'remove from one exact credential store.')
    .action(async (credential) => {
      if (!(await allowOperatorCommand())) return;
      const commandOptions = credentialsUnset.opts();
      const agentId = commandOptions.agent;
      const storeId = commandOptions.store;
      await unsetCredentialsAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
        credential: String(credential),
        credentialManager: options.credentialManager,
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
    .description('install the workspace agent and reconcile configured lifecycle state.')
    .option('--yes', 'confirm setup without prompting.')
    .option('--non-interactive', 'run without interactive prompts.')
    .option('--skip-setup', 'skip all setup checks and applies with a warning.')
    .option('--skip-setup-host', 'skip host setup checks and applies with a warning.')
    .option('--skip-setup-agent', 'skip agent setup checks and applies with a warning.')
    .option(
      '--rebuild-codex-path',
      'replace the saved codex PATH baseline with this process environment.',
    )
    .option('--json', 'write structured json output.')
    .action(async () => {
      if (!(await allowOperatorCommand(install.opts().json === true))) return;
      await installAgentSystem({
        installService: options.installService,
        json: install.opts().json === true,
        yes: install.opts().yes === true,
        nonInteractive: install.opts().nonInteractive === true,
        skipSetup: install.opts().skipSetup === true,
        skipSetupHost: install.opts().skipSetupHost === true,
        skipSetupAgent: install.opts().skipSetupAgent === true,
        rebuildCodexPath: install.opts().rebuildCodexPath === true,
        environment,
        ...(options.input ? { input: options.input } : {}),
        ...(options.setupPrompt ? { prompt: options.setupPrompt } : {}),
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        terminalColumns:
          options.terminalColumns ?? (process.stdout.isTTY ? process.stdout.columns : undefined),
        workspaceDir: cwd(),
      });
    });
}
