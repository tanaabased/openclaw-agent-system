import resolveExampleModelScenario, { exampleModelScenarioIds } from './example-model-scenarios.ts';
import resolveGitHubNotificationModelScenario, {
  githubNotificationModelScenarioIds,
} from './github-notification-model-scenarios.ts';
import type { OpenClawAIMockScenario } from './aimock-scenario.ts';

export const openClawAIMockScenarioIds = Object.freeze([
  ...exampleModelScenarioIds,
  ...githubNotificationModelScenarioIds,
]);

/** Resolve one checked-in example or notification AIMock scenario. */
export default function resolveOpenClawAIMockScenario(scenarioId: string): OpenClawAIMockScenario {
  if (exampleModelScenarioIds.includes(scenarioId)) {
    return resolveExampleModelScenario(scenarioId);
  }
  if (githubNotificationModelScenarioIds.includes(scenarioId)) {
    return resolveGitHubNotificationModelScenario(scenarioId);
  }
  throw new Error(`Unsupported OpenClaw AIMock scenario: ${scenarioId}`);
}
