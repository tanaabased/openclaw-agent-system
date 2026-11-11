import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import issueWorkflowMode from './issue-workflow-mode.ts';
import {
  managedPullRequest,
  managedTargetUrl,
  type ManagedIssue as IntakeRecord,
} from './managed-issue.ts';
import { nativeTurnFor } from './openclaw-native-turns.ts';

import assignmentCard from '../channels/github/presentation/assignment-card.ts';
import { nativeAssessmentInstructions } from './assessment-instructions.ts';
import { assessmentPresentationRequest } from './assessment-render.ts';
import { assessmentResultContextSchema } from './assessment-result.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { describeIssueSession, type DispatchCaller } from './openclaw-session-create.ts';
import { nativeInputEvent } from './openclaw-session-input.ts';
import openClawSkill from './openclaw-skill.ts';
import { selectWorkflowStage } from './workflow-stage.ts';

import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { AssessmentConfiguration } from '../manifest/assessment-schema.ts';

export function assessmentTurnMessage(
  _record: OpenClawDispatchRecord,
  input?: {
    intake: IntakeRecord;
    workspace: string;
    debug?: boolean;
  },
) {
  const assignment = input
    ? assignmentCard({
        emoji: '📥',
        item: {
          kind: managedPullRequest(input.intake) ? 'Pull request' : 'Issue',
          label: `${input.intake.repository.owner.login}/${input.intake.repository.name}#${input.intake.issue.number}`,
          url: managedTargetUrl(input.intake),
        },
        sender: input.intake.assignment
          ? {
              label: input.intake.assignment.actor.login,
              url: 'https://github.com/' + input.intake.assignment.actor.login,
            }
          : undefined,
      })
    : undefined;
  return assignment ?? 'Task assigned.';
}

/** resolve the selected method from this agent's native catalog without fallback. */
export async function selectOpenClawAssessment(input: {
  request: DispatchRequest;
  record: OpenClawDispatchRecord;
  workspace: string;
  configuration?: AssessmentConfiguration;
  now: number;
}) {
  const { record, request, configuration } = input;
  const expected = record.request;
  if (!expected || !('key' in expected)) throw new Error('dispatch-session-intent-missing');
  const { selection } = await selectWorkflowStage({
    stage: 'assessment',
    configuration,
    workspace: input.workspace,
    observedAt: input.now,
    resolveSkill: (id) => openClawSkill(request, expected, id),
  });
  record.assessment ??= selection;
  return selection;
}

export async function issueAssessmentAction(input: {
  request: DispatchRequest;
  record: OpenClawDispatchRecord;
  caller: DispatchCaller;
  intake: IntakeRecord;
  workspace: string;
  policy: GitHubNotificationPolicy | undefined;
  config: OpenClawConfig;
  debug?: boolean;
  action: 'context';
  selection?: OpenClawDispatchRecord['assessment'];
  evidence?: string;
  assertCurrent(): Promise<void>;
  save(): Promise<void>;
}) {
  const { request, record, caller, intake } = input;
  if (
    record.feedback?.events.some(
      (event) => event.turn?.runId === caller.runId || event.turn?.executionRunId === caller.runId,
    ) ||
    !record.sessionCreation?.verified ||
    caller.sessionKey !== record.threadId ||
    caller.sessionId !== record.sessionCreation.sessionId ||
    caller.runId === nativeTurnFor(record, 'first')?.runId
  )
    throw new Error('dispatch-assessment-caller-mismatch');
  await describeIssueSession(request, record, input.config);
  const inputEventId = (
    await nativeInputEvent({
      request,
      sessionKey: caller.sessionKey,
      sessionId: caller.sessionId,
      runId: caller.runId,
      retained: [
        record.assessmentCaller,
        ...(record.nativeTurns ?? []).flatMap(({ turn }) =>
          turn.consumedByEventId
            ? [{ runId: turn.runId, inputEventId: turn.consumedByEventId }]
            : [],
        ),
      ],
    })
  ).inputEventId;
  await input.assertCurrent();
  if (input.action === 'context') {
    record.assessmentCaller = { runId: caller.runId, inputEventId };
    record.assessment = input.selection ?? record.assessment;
    await input.save();
    return {
      status: 'verified',
      runtime: 'openclaw',
      entry: 'managed',
      id: record.id,
      project: { path: record.worktree },
      routing: JSON.parse(record.routing!),
      effective: record.effective,
      executionEffort: 'unverified',
      evidence: JSON.parse(input.evidence ?? record.context!),
      assessment: record.assessment,
      currentTurnId: caller.runId,
      mode: issueWorkflowMode(input.policy, record),
      recording: 'native-context' as const,
      resultContract: 'assessment-result/v1',
      resultSchema: assessmentResultContextSchema,
      presentationRequest: {
        ...assessmentPresentationRequest(managedTargetUrl(intake)),
      },
      instructions: nativeAssessmentInstructions(),
    };
  }
}
