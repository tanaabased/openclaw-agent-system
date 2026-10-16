import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

export const memoryExampleScenario: OpenClawAIMockScenario = {
  id: 'openclaw-memory',
  model: { match: /^text-embedding-3-small$/u, reference: 'text-embedding-3-small' },
  embeddingAuthorization: 'Bearer synthetic-memory-credential',
  fixtures: [
    {
      match: { endpoint: 'embedding', model: 'text-embedding-3-small' },
      response: { embedding: [1, 0, 0] },
    },
  ],
  finalResponses: [],
  systemPromptSignals: [],
  toolCalls: [],
  skipToolSearch: () => true,
};
