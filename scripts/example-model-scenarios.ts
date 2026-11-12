import { issuePickupScenario } from '../examples/openclaw-project-picker/model-fixture.ts';
import { openClawCollaborationScenario } from '../examples/openclaw-collaboration/model-fixture.ts';
import { automationRecoveryScenario } from '../examples/openclaw-automation-recovery/model-fixture.ts';
import { automationCommandChatScenario } from '../examples/openclaw-automation-command-chat/model-fixture.ts';
import { lifecycleApprovalScenario } from '../examples/openclaw-lifecycle-approvals/model-fixture.ts';
import { automationExampleScenario } from '../examples/openclaw-automation-prompt/model-fixture.ts';
import { agentExampleScenario } from '../examples/openclaw-agent/model-fixture.ts';
import { credentialExampleScenario as openClawCredentialScenario } from '../examples/openclaw-credentials/model-fixture.ts';
import { githubExampleScenario } from '../examples/openclaw-github/model-fixture.ts';
import { osExecutionExampleScenario } from '../examples/os-execution/model-fixture.ts';
import { runtimeBoundaryScenario } from '../examples/openclaw-runtimes/model-fixture.ts';
import { memoryExampleScenario } from '../examples/openclaw-memory-embeddings/model-fixture.ts';
import { issueExampleScenario } from '../examples/openclaw-issue-journey/model-fixture.ts';
import { githubReplyExampleScenario } from '../examples/openclaw-github-reply/model-fixture.ts';
import { issueLaunchExampleScenario } from '../examples/openclaw-issue-launch/model-fixture.ts';
import { issueAssessmentExampleScenario } from '../examples/openclaw-issue-assessment/model-fixture.ts';
import { conversationExampleScenario } from '../examples/openclaw-issue-conversation/model-fixture.ts';
import { intakeExampleScenario } from '../examples/openclaw-issue-intake/model-fixture.ts';
import { assessmentRecoveryExampleScenario } from '../examples/openclaw-issue-assessment-recovery/model-fixture.ts';
import { feedbackPolicyExampleScenario } from '../examples/openclaw-issue-feedback-policy/model-fixture.ts';
import { assignmentPolicyExampleScenario } from '../examples/openclaw-issue-assignment-policy/model-fixture.ts';
import { reactivationExampleScenario } from '../examples/openclaw-issue-reactivation/model-fixture.ts';
import { retirementExampleScenario } from '../examples/openclaw-notifications-retirement/model-fixture.ts';
import { nativeRetirementScenario } from '../examples/openclaw-native-retirement/model-fixture.ts';
import { resetExampleScenario } from '../examples/openclaw-notifications-reset/model-fixture.ts';
import { progressionExampleScenario } from '../examples/openclaw-issue-progression/model-fixture.ts';
import { decisionRecoveryExampleScenario } from '../examples/openclaw-issue-decision-recovery/model-fixture.ts';
import { prExampleScenario } from '../examples/openclaw-pr-journey/model-fixture.ts';
import { prUpdateExampleScenario } from '../examples/openclaw-pr-update/model-fixture.ts';
import { prDiscoveryExampleScenario } from '../examples/openclaw-pr-discovery/model-fixture.ts';
import { worktreeExampleScenario } from '../examples/openclaw-worktree-session/model-fixture.ts';
import { automaticDeliveryScenario as workScenario } from '../examples/openclaw-issue-work/model-fixture.ts';
import { automaticDeliveryScenario as customWorkScenario } from '../examples/openclaw-issue-work-custom/model-fixture.ts';
import { automaticDeliveryScenario as autoWorkScenario } from '../examples/openclaw-issue-auto-work/model-fixture.ts';
import { autoPlanScenario } from '../examples/openclaw-issue-auto-plan/model-fixture.ts';
import type { OpenClawAIMockScenario } from './aimock-scenario.ts';

const scenarios = new Map<string, OpenClawAIMockScenario>([
  [issuePickupScenario.id, issuePickupScenario],
  [agentExampleScenario.id, agentExampleScenario],
  [openClawCollaborationScenario.id, openClawCollaborationScenario],
  [automationExampleScenario.id, automationExampleScenario],
  [automationRecoveryScenario.id, automationRecoveryScenario],
  [automationCommandChatScenario.id, automationCommandChatScenario],
  [openClawCredentialScenario.id, openClawCredentialScenario],
  [githubExampleScenario.id, githubExampleScenario],
  [osExecutionExampleScenario.id, osExecutionExampleScenario],
  [runtimeBoundaryScenario.id, runtimeBoundaryScenario],
  [lifecycleApprovalScenario.id, lifecycleApprovalScenario],
  [memoryExampleScenario.id, memoryExampleScenario],
  [worktreeExampleScenario.id, worktreeExampleScenario],
  [prExampleScenario.id, prExampleScenario],
  [prUpdateExampleScenario.id, prUpdateExampleScenario],
  [prDiscoveryExampleScenario.id, prDiscoveryExampleScenario],
  [progressionExampleScenario.id, progressionExampleScenario],
  [decisionRecoveryExampleScenario.id, decisionRecoveryExampleScenario],
  [workScenario.id, workScenario],
  [customWorkScenario.id, customWorkScenario],
  [autoWorkScenario.id, autoWorkScenario],
  [autoPlanScenario.id, autoPlanScenario],
  [issueExampleScenario.id, issueExampleScenario],
  [githubReplyExampleScenario.id, githubReplyExampleScenario],
  [issueAssessmentExampleScenario.id, issueAssessmentExampleScenario],
  [issueLaunchExampleScenario.id, issueLaunchExampleScenario],
  [conversationExampleScenario.id, conversationExampleScenario],
  [intakeExampleScenario.id, intakeExampleScenario],
  [assessmentRecoveryExampleScenario.id, assessmentRecoveryExampleScenario],
  [feedbackPolicyExampleScenario.id, feedbackPolicyExampleScenario],
  [assignmentPolicyExampleScenario.id, assignmentPolicyExampleScenario],
  [reactivationExampleScenario.id, reactivationExampleScenario],
  [retirementExampleScenario.id, retirementExampleScenario],
  [nativeRetirementScenario.id, nativeRetirementScenario],
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
