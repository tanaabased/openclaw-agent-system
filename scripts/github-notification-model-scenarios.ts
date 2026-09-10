import { guidedAssignmentScenario } from '../scenarios/issue-guided-assignment/model-fixture.ts';
import { assignmentScenario } from '../scenarios/issue-work-assignment/model-fixture.ts';
import { commentScenario } from '../scenarios/issue-work-comment/model-fixture.ts';
import { implementationScenario } from '../scenarios/issue-work-implementation/model-fixture.ts';
import { pullRequestLifecycleScenario } from '../scenarios/issue-work-pr-lifecycle/model-fixture.ts';
import { retirementScenario } from '../scenarios/issue-work-retirement/model-fixture.ts';
import type { OpenClawAIMockScenario, OpenClawAIMockToolCall } from './aimock-scenario.ts';

export type GitHubNotificationModelToolCall = OpenClawAIMockToolCall;
export type GitHubNotificationModelScenario = OpenClawAIMockScenario;

const scenarios = new Map<string, GitHubNotificationModelScenario>([
  [assignmentScenario.id, assignmentScenario],
  [guidedAssignmentScenario.id, guidedAssignmentScenario],
  [implementationScenario.id, implementationScenario],
  [pullRequestLifecycleScenario.id, pullRequestLifecycleScenario],
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
