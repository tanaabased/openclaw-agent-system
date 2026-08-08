import type AgentSystemToolRegistry from '../lib/tool-registry.ts';
import {
  AgentSystemToolError,
  type default as AgentSystemToolRuntime,
} from '../lib/tool-runtime.ts';
import { type CliOutput, writeCliJson } from '../lib/cli-output.ts';
import { type Logger, reportError } from '../lib/logger.ts';

export interface RunAgentSystemToolOptions {
  agentId?: string;
  argv: string[];
  command: string;
  logger: Logger;
  output: CliOutput;
  setExitCode(code: number): void;
  toolRegistry: Pick<AgentSystemToolRegistry, 'invoke'>;
  toolRuntime: AgentSystemToolRuntime;
  workspaceDir: string;
}

/** Run one registered command through its agent-bound Agent System tool. */
export default async function runAgentSystemTool(
  options: RunAgentSystemToolOptions,
): Promise<void> {
  try {
    const result = await options.toolRegistry.invoke(
      options.command,
      options.toolRuntime,
      options.argv,
      {
        source: 'command',
        ...(options.agentId
          ? { agentId: options.agentId }
          : { workspaceDir: options.workspaceDir }),
      },
    );
    writeCliJson(options.output, result.output);
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
