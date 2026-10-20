import { openClawCollaborationScenario } from '../examples/openclaw-collaboration/model-fixture.ts';
import { automationExampleScenario } from '../examples/openclaw-automations/model-fixture.ts';
import { agentExampleScenario } from '../examples/openclaw-agent/model-fixture.ts';
import { credentialExampleScenario as openClawCredentialScenario } from '../examples/openclaw-credentials/model-fixture.ts';
import { githubExampleScenario } from '../examples/openclaw-github/model-fixture.ts';
import { osExecutionExampleScenario } from '../examples/os-execution/model-fixture.ts';
import { runtimeBoundaryScenario } from '../examples/openclaw-runtimes/model-fixture.ts';
import { memoryExampleScenario } from '../examples/openclaw-memory/model-fixture.ts';
import { issueExampleScenario } from '../examples/openclaw-issue/model-fixture.ts';
import { intakeExampleScenario } from '../examples/openclaw-intake/model-fixture.ts';
import { lifecycleExampleScenario } from '../examples/openclaw-lifecycle/model-fixture.ts';
import { progressionExampleScenario } from '../examples/openclaw-progression/model-fixture.ts';
import { prExampleScenario } from '../examples/openclaw-pr/model-fixture.ts';
import { worktreeExampleScenario } from '../examples/openclaw-worktree/model-fixture.ts';
import type { OpenClawAIMockScenario } from './aimock-scenario.ts';

const scenarios = new Map<string, OpenClawAIMockScenario>([
  [agentExampleScenario.id, agentExampleScenario],
  [openClawCollaborationScenario.id, openClawCollaborationScenario],
  [automationExampleScenario.id, automationExampleScenario],
  [openClawCredentialScenario.id, openClawCredentialScenario],
  [githubExampleScenario.id, githubExampleScenario],
  [osExecutionExampleScenario.id, osExecutionExampleScenario],
  [runtimeBoundaryScenario.id, runtimeBoundaryScenario],
  [memoryExampleScenario.id, memoryExampleScenario],
  [worktreeExampleScenario.id, worktreeExampleScenario],
  [prExampleScenario.id, prExampleScenario],
  [progressionExampleScenario.id, progressionExampleScenario],
  [issueExampleScenario.id, issueExampleScenario],
  [intakeExampleScenario.id, intakeExampleScenario],
  [lifecycleExampleScenario.id, lifecycleExampleScenario],
]);

export const exampleModelScenarioIds = Object.freeze([...scenarios.keys()]);

/** Resolve one checked-in general example model scenario. */
export default function resolveExampleModelScenario(scenarioId: string): OpenClawAIMockScenario {
  const scenario = scenarios.get(scenarioId);
  if (!scenario) {
    throw new Error(`Unsupported example model scenario: ${scenarioId}`);
  }
  return scenario;
}
