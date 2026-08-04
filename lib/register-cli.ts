import installAgentSystem from '../cli/install.ts';
import validateAgentSystem from '../cli/validate.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type AgentInstallService from './agent-install-service.ts';
import { type CliOutput, defaultCliOutput } from './cli-output.ts';

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
  installService: Pick<AgentInstallService, 'install'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output?: CliOutput;
  setExitCode?: (code: number) => void;
}

function writeHelp(command: CommandLike, output: CliOutput): void {
  const help = command.helpInformation();
  output.write(help.endsWith('\n') ? help : `${help}\n`);
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
        manifestService: options.manifestService,
        output,
        setExitCode,
        workspaceDir: cwd(),
      });
    });
  agentSystem
    .command('install')
    .description('Install the workspace agent and reconcile its manifest identity.')
    .action(async () => {
      await installAgentSystem({
        installService: options.installService,
        manifestService: options.manifestService,
        output,
        setExitCode,
        workspaceDir: cwd(),
      });
    });
}
