import type AgentSystemToolRuntime from '../api/runtime.ts';
import type { DispatchCaller } from '../agent/openclaw-session-create.ts';
import type { GitToolDefinition } from '../tools/git/tool.ts';

/** keep delivery git inside the same binding and validation path as agent git. */
export default async function executeOpenClawDeliveryGit(input: {
  runtime: AgentSystemToolRuntime;
  definition: GitToolDefinition;
  agentId: string;
  worktree: string;
  caller: Pick<DispatchCaller, 'sessionKey' | 'sessionId'>;
  signal: AbortSignal;
  argv: string[];
}): Promise<string> {
  const result = await input.runtime.executeCli(
    input.definition,
    { argv: input.argv, cwd: input.worktree },
    {
      source: 'tool',
      admittedWorkingDirectories: [input.worktree],
      toolContext: {
        agentId: input.agentId,
        workspaceDir: input.worktree,
        sessionKey: input.caller.sessionKey,
        sessionId: input.caller.sessionId,
      },
    },
    input.signal,
  );
  if (result.output.exitCode !== 0 || result.output.truncated)
    throw new Error('delivery-git-operation-failed');
  return result.output.stdout;
}
