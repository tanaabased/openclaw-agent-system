import type { ChatCompletionRequest, Fixture } from '@copilotkit/aimock';

export interface OpenClawAIMockToolCall {
  id: string;
  name: string;
  resultMarker?: string;
}

/** One strict fixture set and its expected observable exchange. */
export interface OpenClawAIMockScenario {
  embeddingAuthorization?: string;
  expectedDeniedToolCalls?: readonly OpenClawAIMockToolCall[];
  expectedInvalidToolCalls?: readonly OpenClawAIMockToolCall[];
  /** Scenarios that assert individual pages consume those tools’ receipts themselves. */
  manuallyPagedTools?: readonly string[];
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
