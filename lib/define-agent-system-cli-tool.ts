import type { TSchema } from 'typebox';

import defineAgentSystemTool from './define-agent-system-tool.ts';
import type { AgentSystemCliToolDefinition } from './tool-types.ts';

/** Compile one command-backed definition into native and CLI tool surfaces. */
export default function defineAgentSystemCliTool<
  TParameters extends TSchema,
  TDeclaredConfiguration,
  TResolvedConfiguration,
  TOutput,
>(
  definition: AgentSystemCliToolDefinition<
    TParameters,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    TOutput
  >,
) {
  return defineAgentSystemTool(definition, (runtime, input, scope, signal) =>
    runtime.executeCli(definition, input, scope, signal),
  );
}
