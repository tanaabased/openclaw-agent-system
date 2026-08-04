import type AgentManifestService from './agent-manifest-service.ts';
import type { AgentManifestLoadResult } from './agent-manifest-service.ts';

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

export interface CliOutput {
  error(message: string): void;
  write(message: string): void;
}

export interface RegisterAgentSystemCliOptions {
  cwd?: () => string;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForWorkspace'>;
  output?: CliOutput;
  setExitCode?: (code: number) => void;
}

const defaultOutput: CliOutput = {
  error(message) {
    process.stderr.write(message);
  },
  write(message) {
    process.stdout.write(message);
  },
};

function writeHelp(command: CommandLike, output: CliOutput): void {
  const help = command.helpInformation();
  output.write(help.endsWith('\n') ? help : `${help}\n`);
}

function reportDiagnostics(result: AgentManifestLoadResult, output: CliOutput): void {
  for (const diagnostic of result.diagnostics) {
    const location = diagnostic.fieldPath ? ` (${diagnostic.fieldPath})` : '';
    output.error(`${diagnostic.severity}: [${diagnostic.code}]${location} ${diagnostic.message}\n`);
  }
}

function reportValidation(
  result: AgentManifestLoadResult,
  output: CliOutput,
  setExitCode: (code: number) => void,
): void {
  if (result.status === 'loaded') {
    output.write(
      `valid: Agent System manifest for ${result.manifest.agent.id} at ${result.path}\n`,
    );
    reportDiagnostics(result, output);
    return;
  }

  if (result.status === 'unmanaged') {
    output.error(`error: no Agent System manifest found in ${result.scope.workspaceDir}\n`);
  } else if (result.status === 'invalid') {
    output.error(
      `error: invalid Agent System manifest${result.path ? ` at ${result.path}` : ''}\n`,
    );
    reportDiagnostics(result, output);
  } else {
    output.error('error: an OpenClaw agent workspace could not be resolved\n');
    reportDiagnostics(result, output);
  }

  setExitCode(1);
}

/** Register the plugin-owned command tree over the manifest service. */
export default function registerAgentSystemCli(
  program: CommandLike,
  options: RegisterAgentSystemCliOptions,
): void {
  const cwd = options.cwd ?? process.cwd;
  const output = options.output ?? defaultOutput;
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
      const result =
        typeof agentId === 'string'
          ? await options.manifestService.loadForAgentId(agentId, 'cli')
          : await options.manifestService.loadForWorkspace(cwd(), undefined, 'cli');
      reportValidation(result, output, setExitCode);
    });
}
