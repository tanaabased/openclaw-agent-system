import { openClawCollaborationScenario } from '../examples/openclaw-collaboration/model-fixture.ts';
import { automationExampleScenario } from '../examples/openclaw-automations/model-fixture.ts';
import { agentExampleScenario } from '../examples/openclaw-agent/model-fixture.ts';
import { credentialExampleScenario as openClawCredentialScenario } from '../examples/openclaw-credentials/model-fixture.ts';
import { githubExampleScenario } from '../examples/openclaw-github/model-fixture.ts';
import { osExecutionExampleScenario } from '../examples/os-execution/model-fixture.ts';
import { runtimeBoundaryScenario } from '../examples/openclaw-runtimes/model-fixture.ts';
import { memoryExampleScenario } from '../examples/openclaw-memory/model-fixture.ts';
import { issueExampleScenario } from '../examples/openclaw-notifications-issue-journey/model-fixture.ts';
import { githubReplyExampleScenario } from '../examples/openclaw-github-reply/model-fixture.ts';
import { issueAssessmentExampleScenario } from '../examples/openclaw-issue-assessment/model-fixture.ts';
import { conversationExampleScenario } from '../examples/openclaw-notifications-conversation/model-fixture.ts';
import { intakeExampleScenario } from '../examples/openclaw-notifications-intake/model-fixture.ts';
import { assessmentRecoveryExampleScenario } from '../examples/openclaw-notifications-assessment-recovery/model-fixture.ts';
import { feedbackPolicyExampleScenario } from '../examples/openclaw-notifications-feedback-policy/model-fixture.ts';
import { assignmentPolicyExampleScenario } from '../examples/openclaw-notifications-assignment-policy/model-fixture.ts';
import { reactivationExampleScenario } from '../examples/openclaw-notifications-reactivation/model-fixture.ts';
import { retirementExampleScenario } from '../examples/openclaw-notifications-retirement/model-fixture.ts';
import { resetExampleScenario } from '../examples/openclaw-notifications-reset/model-fixture.ts';
import { progressionExampleScenario } from '../examples/openclaw-notifications-progression/model-fixture.ts';
import { prExampleScenario } from '../examples/openclaw-notifications-pr-delivery/model-fixture.ts';
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
  [githubReplyExampleScenario.id, githubReplyExampleScenario],
  [issueAssessmentExampleScenario.id, issueAssessmentExampleScenario],
  [conversationExampleScenario.id, conversationExampleScenario],
  [intakeExampleScenario.id, intakeExampleScenario],
  [assessmentRecoveryExampleScenario.id, assessmentRecoveryExampleScenario],
  [feedbackPolicyExampleScenario.id, feedbackPolicyExampleScenario],
  [assignmentPolicyExampleScenario.id, assignmentPolicyExampleScenario],
  [reactivationExampleScenario.id, reactivationExampleScenario],
  [retirementExampleScenario.id, retirementExampleScenario],
  [resetExampleScenario.id, resetExampleScenario],
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
