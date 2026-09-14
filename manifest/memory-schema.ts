import { Type, type Static } from 'typebox';

export type AgentMemorySearchConfiguration =
  | { provider: 'none' }
  | { provider: 'local' }
  | { apiKey?: string; model?: string; provider: 'openai' };

export interface AgentMemoryConfiguration {
  search: AgentMemorySearchConfiguration;
}

const providerOnlySearchSchema = (provider: 'local' | 'none') =>
  Type.Object({ provider: Type.Literal(provider) }, { additionalProperties: false });

const openAiSearchSchema = Type.Object(
  {
    provider: Type.Literal('openai'),
    model: Type.Optional(
      Type.String({ minLength: 1, pattern: '^[^\\u0000\\r\\n]*\\S[^\\u0000\\r\\n]*$' }),
    ),
    'api-key': Type.Optional(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' })),
  },
  { additionalProperties: false },
);

export const externalAgentMemorySchema = Type.Object(
  {
    search: Type.Union([
      providerOnlySearchSchema('none'),
      providerOnlySearchSchema('local'),
      openAiSearchSchema,
    ]),
  },
  { additionalProperties: false },
);

type ExternalAgentMemory = Static<typeof externalAgentMemorySchema>;

export function decodeAgentMemory(memory: ExternalAgentMemory): AgentMemoryConfiguration {
  const search = memory.search;
  if (search.provider !== 'openai') return { search: { provider: search.provider } };
  return {
    search: {
      provider: 'openai',
      ...(search.model === undefined ? {} : { model: search.model }),
      ...(search['api-key'] === undefined ? {} : { apiKey: search['api-key'] }),
    },
  };
}
