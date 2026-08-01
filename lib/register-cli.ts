type Action = (...args: unknown[]) => unknown;

export interface CommandLike {
  action(handler: Action): CommandLike;
  alias(name: string): CommandLike;
  command(specification: string): CommandLike;
  description(text: string): CommandLike;
}

export interface CliOutput {
  write(message: string): void;
}

export interface RegisterAgentSystemCliOptions {
  output?: CliOutput;
}

const defaultOutput: CliOutput = {
  write(message) {
    process.stdout.write(message);
  },
};

export default function registerAgentSystemCli(
  program: CommandLike,
  options: RegisterAgentSystemCliOptions = {},
): void {
  const output = options.output ?? defaultOutput;

  program
    .command('agent-system')
    .alias('as')
    .description('Manage reproducible OpenClaw agent workspaces.')
    .action(() => {
      output.write('Agent System for OpenClaw is installed.\n');
    });
}
