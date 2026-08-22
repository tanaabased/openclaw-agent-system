import type { Readable } from 'node:stream';

import type AgentSystemToolRegistry from '../api/registry.ts';
import AgentSystemToolError from '../api/error.ts';
import type AgentSystemToolRuntime from '../api/runtime.ts';
import type { AgentCommandBinding } from '../agent/command-authority.ts';
import { type CliOutput, writeCliError } from './output.ts';
import { formatErrorDiagnostic } from '../core/logger.ts';
import readToolCommandStdin from '../api/read-command-stdin.ts';

export interface RunAgentSystemToolOptions {
  agentId?: string;
  argv: string[];
  command: string;
  input?: Readable;
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
    let stdin: string | undefined;
    try {
      stdin = await readToolCommandStdin(options.input);
    } catch (error) {
      throw new AgentSystemToolError(
        error instanceof RangeError ? 'invalid_arguments' : 'execution_failed',
        error instanceof RangeError
          ? error.message
          : 'Tool command standard input could not be read.',
      );
    }
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
      stdin,
    );
    if (result.kind === 'semantic') {
      const serialized = JSON.stringify(result.output, undefined, 2);
      if (serialized !== undefined) options.output.writeStdout(`${serialized}\n`);
      return;
    }
    if (result.commandResult.stdout) options.output.writeStdout(result.commandResult.stdout);
    if (result.commandResult.stderr) {
      options.output.writeStderr(result.commandResult.stderr);
    }
    if (result.commandResult.exitCode !== 0) {
      options.setExitCode(result.commandResult.exitCode ?? 1);
    }
  } catch (error) {
    writeCliError(
      options.output,
      formatErrorDiagnostic(
        'tool',
        error,
        error instanceof AgentSystemToolError ? error.code : undefined,
      ),
    );
    options.setExitCode(1);
  }
}
