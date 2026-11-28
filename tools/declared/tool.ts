import { Type } from 'typebox';
import { Value } from 'typebox/value';
import defineAgentSystemTool from '../../api/define-tool.ts';
import AgentSystemToolError from '../../api/error.ts';

const parameters = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    argv: Type.Array(Type.String()),
    stdin: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const declaredTool = defineAgentSystemTool(
  {
    apiVersion: 1,
    id: 'declared',
    configuration: { read: (manifest) => manifest.tools, resolve: (value) => value },
    tool: {
      name: 'agent_system_run_declared',
      label: 'Run declared command',
      description:
        'Run a CLI declared by the bound agent. Pass its identifier and literal arguments.',
      parameters,
      classify: (input) => ({ action: input.id, risk: 'unknown', summary: 'Run declared command' }),
      inputFromCommand: ([id = '', ...argv], stdin) => ({
        id,
        argv,
        ...(stdin === undefined ? {} : { stdin }),
      }),
    },
  },
  (runtime, input, scope, signal) => {
    if (!Value.Check(parameters, input))
      throw new AgentSystemToolError('invalid_arguments', 'Invalid declared tool request.');
    return runtime.executeDeclared(input, scope, signal);
  },
);
