import resolveExampleModelScenario, { exampleModelScenarioIds } from './example-model-scenarios.ts';
import type { OpenClawAIMockScenario } from './aimock-scenario.ts';

export const openClawAIMockScenarioIds = exampleModelScenarioIds;

/** resolve one checked-in example AIMock scenario. */
export default function resolveOpenClawAIMockScenario(scenarioId: string): OpenClawAIMockScenario {
  if (exampleModelScenarioIds.includes(scenarioId)) {
    return resolveExampleModelScenario(scenarioId);
  }
  throw new Error(`Unsupported OpenClaw AIMock scenario: ${scenarioId}`);
}
