import type AgentSystemToolRegistry from '../lib/tool-registry.ts';
import AgentSystemToolError from '../lib/tool-error.ts';
import type AgentSystemToolRuntime from '../lib/tool-runtime.ts';
import type { AgentCommandBinding } from '../lib/agent-command-authority.ts';
import type { CliOutput } from '../lib/cli-output.ts';
import { type Logger, reportError } from '../lib/logger.ts';

export interface RunAgentSystemToolOptions {
  agentId?: string;
  argv: string[];
  command: string;
  logger: Logger;
  output: CliOutput;
  setExitCode(code: number): void;
  terminalColumns?: number;
  resolveCommandBinding?(
    environment: Readonly<NodeJS.ProcessEnv>,
    cwd: string,
  ): Promise<AgentCommandBinding | undefined>;
  toolRegistry: Pick<AgentSystemToolRegistry, 'invoke'>;
  toolRuntime: AgentSystemToolRuntime;
  workspaceDir: string;
}

/** Run one registered command through its agent-bound Agent System tool. */
export default async function runAgentSystemTool(
  options: RunAgentSystemToolOptions,
): Promise<void> {
  try {
    const binding = await options.resolveCommandBinding?.(process.env, options.workspaceDir);
    if (binding && options.agentId) {
      throw new AgentSystemToolError(
        'invalid_arguments',
        'An active agent command binding may not select another agent.',
      );
    }
    const result = await options.toolRegistry.invoke(
      options.command,
      options.toolRuntime,
      options.argv,
      {
        ...(binding
          ? {
              admittedWorkingDirectories: binding.admittedWorkingDirectories,
              agentId: binding.agentId,
              source: 'agent-command' as const,
              workspaceDir: binding.workingDirectory,
            }
          : {
              ...(options.agentId ? { agentId: options.agentId } : {}),
              source: 'command' as const,
              workspaceDir: options.workspaceDir,
            }),
        ...(options.terminalColumns === undefined
          ? {}
          : { terminalColumns: options.terminalColumns }),
      },
    );
    if (result.kind === 'semantic') {
      const serialized = JSON.stringify(result.output, undefined, 2);
      if (serialized !== undefined) options.output.writeStdout(`${serialized}\n`);
      return;
    }
    if (result.commandResult.stdout) options.output.writeStdout(result.commandResult.stdout);
    if (result.commandResult.stderr) {
      (options.output.writeStderr ?? options.output.writeStdout)(result.commandResult.stderr);
    }
    if (result.commandResult.exitCode !== 0) {
      options.setExitCode(result.commandResult.exitCode ?? 1);
    }
  } catch (error) {
    reportError(
      options.logger,
      'tool',
      error,
      error instanceof AgentSystemToolError ? error.code : undefined,
    );
    options.setExitCode(1);
  }
}
