import { dispatchAssessmentContext } from './dispatch-presentation.ts';
import issueWorkflowMode from './issue-workflow-mode.ts';
import {
  managedTargetUrl,
  managedPullRequest,
  type ManagedIssue as IntakeRecord,
} from './managed-issue.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import assignmentCard from '../channels/github/presentation/assignment-card.ts';
import { nativeAssessmentInstructions } from './assessment-instructions.ts';
import { assessmentResultContextSchema, parseAssessmentSubmission } from './assessment-result.ts';
import renderNativeAssessment, { assessmentPresentationRequest } from './assessment-render.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import openClawSkill from './openclaw-skill.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import issueInputEvent, { issueInputEventId } from './openclaw-session-input.ts';
import { completeOpenClawMessage, openClawHistoryPages } from './openclaw-history.ts';
import {
  describeIssueSession,
  sessionObject,
  type DispatchCaller,
} from './openclaw-session-create.ts';

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
    ? assignmentCard(
        {
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
        },
        'Assess this issue and prepare a plan in the chat, then continue within its configured mode and current user direction.',
      )
    : undefined;
  return assignment ?? 'Assess the admitted task and prepare a plan in this chat.';
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
  action: 'context' | 'result';
  selection?: OpenClawDispatchRecord['assessment'];
  result?: unknown;
  evidence?: string;
  previousResultDigest?: string;
  assertCurrent(): Promise<void>;
  save(): Promise<void>;
}) {
  const { request, record, caller, intake } = input;
  if (
    record.feedback?.events.some(
      (event) => event.turn?.runId === caller.runId || event.turn?.executionRunId === caller.runId,
    ) ||
    !record.assessmentTurn ||
    !record.assessment ||
    !record.sessionCreation?.verified ||
    caller.sessionKey !== record.threadId ||
    caller.sessionId !== record.sessionCreation.sessionId ||
    caller.runId === record.firstTurn?.runId
  )
    throw new Error('dispatch-assessment-caller-mismatch');
  await describeIssueSession(request, record, input.config);
  let inputEventId =
    record.assessmentCaller?.runId === caller.runId
      ? record.assessmentCaller.inputEventId
      : undefined;
  if (!inputEventId) {
    const history = sessionObject(
      await request('chat.history', {
        sessionKey: record.threadId,
        inputRunIds: [caller.runId],
      }),
    );
    if (history.sessionId !== caller.sessionId || !Array.isArray(history.messages))
      throw new Error('dispatch-assessment-history-unverified');
    const key = `${caller.runId}:user`;
    let users: Record<string, unknown>[] = [];
    for await (const messages of openClawHistoryPages(request, caller, { first: history })) {
      users = messages.filter(
        (entry) =>
          entry.role === 'user' &&
          entry.__openclaw &&
          (sessionObject(entry.__openclaw).runId === caller.runId ||
            sessionObject(entry.__openclaw).idempotencyKey === key ||
            entry.idempotencyKey === key),
      );
      if (users.length) break;
    }
    if (users.length !== 1) throw new Error('dispatch-assessment-input-unverified');
    const user = await completeOpenClawMessage(request, caller, users[0]!);
    const meta = sessionObject(user.__openclaw);
    if (typeof meta.id !== 'string' || !meta.id || meta.truncated === true)
      throw new Error('dispatch-assessment-input-unverified');
    if (caller.runId === record.assessmentTurn.runId) {
      if (issueInputEvent(user, record.assessmentTurn) !== meta.id)
        throw new Error('dispatch-assessment-input-mismatch');
    } else {
      if (issueInputEventId(user, caller.runId) !== meta.id)
        throw new Error('dispatch-assessment-input-unverified');
    }
    inputEventId = meta.id;
  }
  await input.assertCurrent();
  if (input.action === 'context') {
    if (caller.runId === record.assessmentTurn.runId) {
      if (
        record.assessmentTurn.consumedByEventId &&
        record.assessmentTurn.consumedByEventId !== inputEventId
      )
        throw new Error('dispatch-assessment-input-mismatch');
      record.assessmentTurn.consumedByEventId = inputEventId;
      if (record.assessmentTurn.status !== 'completed') record.assessmentTurn.status = 'consumed';
    }
    record.assessmentCaller = { runId: caller.runId, inputEventId };
    // current context uses fresh inputs; exact historical publication owns its saved source.
    record.turnEvidence = {
      runId: caller.runId,
      inputEventId,
      evidence: input.evidence ?? record.context!,
      selection: input.selection ?? record.assessment,
    };
    await input.save();
    return {
      status: 'verified',
      runtime: 'openclaw',
      entry: 'managed',
      id: record.id,
      project: { path: record.worktree },
      routing: JSON.parse(record.routing!),
      routingNote: record.routingNote,
      effective: record.effective,
      executionEffort: 'unverified',
      evidence: JSON.parse(record.turnEvidence?.evidence ?? record.context!),
      assessment: record.turnEvidence?.selection ?? record.assessment,
      currentTurnId: caller.runId,
      mode: issueWorkflowMode(input.policy, record),
      recording: 'native-context' as const,
      resultContract: 'assessment-result/v1',
      resultSchema: assessmentResultContextSchema,
      presentationRequest: {
        id: record.id,
        ...assessmentPresentationRequest(
          managedTargetUrl(intake),
          false,
          dispatchAssessmentContext(
            {
              ...record,
              assessment: record.turnEvidence?.selection ?? record.assessment,
              stageReceipt: undefined,
            },
            input.workspace,
            { debug: input.debug },
          ),
        ),
      },
      instructions: nativeAssessmentInstructions(),
    };
  }
  if (
    record.assessmentCaller?.runId !== caller.runId ||
    record.assessmentCaller.inputEventId !== inputEventId
  )
    throw new Error('dispatch-assessment-context-required');
  const candidate = parseAssessmentSubmission(input.result);
  return {
    id: record.id,
    ...renderNativeAssessment(
      {
        ...assessmentPresentationRequest(
          managedTargetUrl(intake),
          false,
          dispatchAssessmentContext(
            {
              ...record,
              assessment: record.turnEvidence?.selection ?? record.assessment,
              stageReceipt: undefined,
            },
            input.workspace,
            { debug: input.debug },
          ),
        ),
        result: {
          ...candidate,
          reviewSummary:
            candidate.reviewSummary ??
            [
              candidate.summary,
              ...(candidate.outcome === 'clarification-needed'
                ? candidate.questions
                : candidate.outcome === 'operator-setup-blocker'
                  ? [candidate.remediation]
                  : []),
            ].join('\n\n'),
        },
      },
      'openclaw',
    ),
  };
}
