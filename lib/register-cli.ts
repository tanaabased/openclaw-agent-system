import envAgentSystem from '../cli/env.ts';
import setCredentialsAgentSystem from '../cli/credentials-set.ts';
import unsetCredentialsAgentSystem from '../cli/credentials-unset.ts';
import validateCredentialsAgentSystem from '../cli/credentials-validate.ts';
import installAgentSystem from '../cli/install.ts';
import validateAgentSystem from '../cli/validate.ts';
import type AgentEnvironmentService from './agent-environment-service.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type AgentInstallService from './agent-install-service.ts';
import { type CliOutput, type CliStyles, defaultCliOutput, writeCliLines } from './cli-output.ts';
import type { Logger } from './logger.ts';
import type OpCredentialManager from './op-credential-manager.ts';

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
  cwd?: () => string;
  credentialManager: Pick<OpCredentialManager, 'setFromEnvironment' | 'unset' | 'validate'>;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId' | 'loadForWorkspace'>;
  installService: Pick<AgentInstallService, 'install'>;
  logger: Logger;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output?: CliOutput;
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
    .action(async () => {
      const agentId = validate.opts().agent;
      await validateAgentSystem({
        ...(typeof agentId === 'string' ? { agentId } : {}),
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
  const credentials = agentSystem
    .command('credentials')
    .description('Manage agent-scoped environment-provider credentials.')
    .action(() => writeHelp(credentials, output));
  const credentialsSet = credentials
    .command('set <credential>')
    .description('Validate and store a credential from an explicit source.')
    .option('--agent <id>', 'Use the configured workspace for an OpenClaw agent.')
    .option('--store <id>', 'Write to an explicit credential store.')
    .option('--from-env', 'Read the credential from the process environment.')
    .action(async (credential) => {
      const commandOptions = credentialsSet.opts();
      const agentId = commandOptions.agent;
      const storeId = commandOptions.store;
      await setCredentialsAgentSystem({
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
  const credentialsValidate = credentials
    .command('validate <credential>')
    .description('Validate a credential against the current manifest.')
    .option('--agent <id>', 'Use the configured workspace for an OpenClaw agent.')
    .option('--store <id>', 'Require an explicit credential store.')
    .action(async (credential) => {
      const commandOptions = credentialsValidate.opts();
      const agentId = commandOptions.agent;
      const storeId = commandOptions.store;
      await validateCredentialsAgentSystem({
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
  const credentialsUnset = credentials
    .command('unset <credential>')
    .description('Remove a credential from an explicit store.')
    .option('--agent <id>', 'Use the configured workspace for an OpenClaw agent.')
    .option('--store <id>', 'Remove from an explicit credential store.')
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
  agentSystem
    .command('install')
    .description('Install the workspace agent and reconcile its manifest identity.')
    .action(async () => {
      await installAgentSystem({
        installService: options.installService,
        logger: options.logger,
        manifestService: options.manifestService,
        output,
        setExitCode,
        styles: options.styles,
        workspaceDir: cwd(),
      });
    });
}
