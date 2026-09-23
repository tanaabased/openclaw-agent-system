import type { Readable } from 'node:stream';

import type AgentSystemToolRegistry from '../api/registry.ts';
import AgentSystemToolError from '../api/error.ts';
import type AgentSystemToolRuntime from '../api/runtime.ts';
import type { AgentCommandBinding, AgentCommandContext } from '../agent/command-authority.ts';
import runHostCommand from '../api/host-command.ts';
import { type CliOutput, writeCliError } from './output.ts';
import { formatErrorDiagnostic } from '../core/logger.ts';
import readToolCommandStdin from '../api/read-command-stdin.ts';

export interface RunAgentSystemToolOptions {
  invocationMode: 'operator' | 'managed' | 'contextual';
  resolveCommandContext?(
    environment: Readonly<NodeJS.ProcessEnv>,
    cwd: string,
  ): Promise<AgentCommandContext>;
  runHostCommand?: typeof runHostCommand;
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
  toolRegistry: Pick<AgentSystemToolRegistry, 'invoke' | 'hostFallback'>;
  toolRuntime: AgentSystemToolRuntime;
  workspaceDir: string;
}

/** Run one registered command through its agent-bound Agent System tool. */
export default async function runAgentSystemTool(
  options: RunAgentSystemToolOptions,
): Promise<void> {
  try {
    let binding: AgentCommandBinding | undefined;
    if (options.invocationMode === 'contextual') {
      if (options.agentId || !options.resolveCommandContext) {
        throw new AgentSystemToolError(
          'agent_not_resolved',
          'The command shim context is invalid.',
        );
      }
      const context = await options.resolveCommandContext(process.env, options.workspaceDir);
      if (context.status === 'managed') {
        binding = context.binding;
      } else {
        const executable = options.toolRegistry.hostFallback(options.command);
        if (!executable) {
          throw new AgentSystemToolError(
            'agent_not_resolved',
            'This command requires a managed agent context.',
          );
        }
        await (options.runHostCommand ?? runHostCommand)(
          executable,
          options.argv,
          process.env,
          context.status === 'outside-agent-scope' ? context.admittedWorkingDirectories : [],
        );
        return;
      }
    } else {
      binding = await options.resolveCommandBinding?.(process.env, options.workspaceDir);
      if (options.invocationMode === 'managed' && (!binding || options.agentId)) {
        throw new AgentSystemToolError(
          'agent_not_resolved',
          'A strict managed launcher requires an active agent binding.',
        );
      }
    }
    if (binding && options.agentId) {
      throw new AgentSystemToolError(
        'invalid_arguments',
        'An active agent command binding may not select another agent.',
      );
    }
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
    if (binding?.executeCommand) {
      const result = await binding.executeCommand({
        command: options.command,
        argv: options.argv,
        ...(stdin === undefined ? {} : { stdin }),
      });
      if (result.stdout) options.output.writeStdout(result.stdout);
      if (result.stderr) options.output.writeStderr(result.stderr);
      if (result.exitCode !== 0) options.setExitCode(result.exitCode ?? 1);
      return;
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
