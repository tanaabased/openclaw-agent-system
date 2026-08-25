import type { Fixture } from '@copilotkit/aimock';

import { assignmentScenario } from '../scenarios/issue-work-assignment/model-fixture.ts';
import { assignmentProviderProof } from '../scenarios/issue-work-assignment-provider-proof/model-fixture.ts';
import { retirementScenario } from '../scenarios/issue-work-retirement/model-fixture.ts';

export interface GitHubNotificationModelToolCall {
  id: string;
  name: string;
}

export interface GitHubNotificationModelScenario {
  finalResponses: readonly string[];
  fixtures: readonly Fixture[];
  id: string;
  model: {
    match: RegExp;
    reference: string;
  };
  promptSignals: readonly string[];
  toolCalls: readonly GitHubNotificationModelToolCall[];
}

const scenarios = new Map<string, GitHubNotificationModelScenario>([
  [assignmentScenario.id, assignmentScenario],
  [retirementScenario.id, retirementScenario],
  [assignmentProviderProof.id, assignmentProviderProof],
]);

export const githubNotificationModelScenarioIds = Object.freeze([...scenarios.keys()]);

/** Resolve one checked-in notification model scenario by workflow identity. */
export default function resolveGitHubNotificationModelScenario(
  scenarioId: string,
): GitHubNotificationModelScenario {
  const scenario = scenarios.get(scenarioId);
  if (!scenario) {
    throw new Error(`Unsupported GitHub notification model scenario: ${scenarioId}`);
  }
  return scenario;
}
