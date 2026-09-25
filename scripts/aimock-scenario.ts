import type { ChatCompletionRequest, Fixture } from '@copilotkit/aimock';

export interface OpenClawAIMockToolCall {
  id: string;
  name: string;
}

/** One strict fixture set and its expected observable exchange. */
export interface OpenClawAIMockScenario {
  skipToolSearch?: (request: ChatCompletionRequest) => boolean;
  toolSearchDiscoveryFixture?: Fixture;
  dynamicFinalResponseFixtures?: readonly Fixture[];
  finalResponses: readonly string[];
  fixtures: readonly Fixture[];
  id: string;
  model: {
    match: RegExp;
    reference: string;
  };
  systemPromptSignals: readonly string[];
  toolCalls: readonly OpenClawAIMockToolCall[];
  userPromptSignals?: readonly string[];
}
