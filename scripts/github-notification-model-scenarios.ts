import type { Fixture } from '@copilotkit/aimock';

import { assignmentScenario } from '../scenarios/issue-work-assignment/model-fixture.ts';
import { commentScenario } from '../scenarios/issue-work-comment/model-fixture.ts';
import { implementationScenario } from '../scenarios/issue-work-implementation/model-fixture.ts';
import { pullRequestContinuationScenario } from '../scenarios/issue-work-pr-continuation/model-fixture.ts';
import { pullRequestHandoffScenario } from '../scenarios/issue-work-pr-handoff/model-fixture.ts';
import { pullRequestRetirementScenario } from '../scenarios/issue-work-pr-retirement/model-fixture.ts';
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
  systemPromptSignals: readonly string[];
  toolCalls: readonly GitHubNotificationModelToolCall[];
  userPromptSignals?: readonly string[];
}

const scenarios = new Map<string, GitHubNotificationModelScenario>([
  [assignmentScenario.id, assignmentScenario],
  [implementationScenario.id, implementationScenario],
  [pullRequestHandoffScenario.id, pullRequestHandoffScenario],
  [pullRequestContinuationScenario.id, pullRequestContinuationScenario],
  [pullRequestRetirementScenario.id, pullRequestRetirementScenario],
  [commentScenario.id, commentScenario],
  [retirementScenario.id, retirementScenario],
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
