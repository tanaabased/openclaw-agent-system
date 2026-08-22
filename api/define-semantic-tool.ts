import type { TSchema } from 'typebox';

import defineAgentSystemTool from './define-tool.ts';
import type { AgentSystemSemanticToolDefinition } from './types.ts';

/** Compile one semantic definition into native and command tool surfaces. */
export default function defineAgentSystemSemanticTool<
  TParameters extends TSchema,
  TDeclaredConfiguration,
  TResolvedConfiguration,
  TOutput,
>(
  definition: AgentSystemSemanticToolDefinition<
    TParameters,
    TDeclaredConfiguration,
    TResolvedConfiguration,
    TOutput
  >,
) {
  return defineAgentSystemTool(definition, (runtime, input, scope, signal) =>
    runtime.executeSemantic(definition, input, scope, signal),
  );
}
