import issueProgression from './issue-progression.ts';
import { workflowFeedbackEnabled } from '../channels/github/feedback-policy.ts';
import liveWorkflowPolicy, { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import retainedIntakePolicy from './retained-intake-policy.ts';
import { notificationAuthorityDigest } from './notification-authority.ts';
import type codexRetirementNative from './codex-retirement-native.ts';
import reconcileCodexLifecycle from './codex-assignment-lifecycle.ts';
import reconcileCodexCapacity from './codex-capacity-reconcile.ts';
import workflowRecovery from './workflow-recovery.ts';
import workflowStatus from './workflow-status.ts';
import workflowFailure from './workflow-failure.ts';
import { dispatchFailurePhase, scheduleDispatchRetry } from './dispatch-retry.ts';
import codexSummaryAuthority from './codex-summary-authority.ts';
import assessmentSummary from './assessment-summary.ts';
import {
  assessmentSummaryInstructions,
  type AssessmentSummaryRequest,
} from './assessment-summary-state.ts';
import selectFeedbackStage from './feedback-stage.ts';
import connectCodexFeedback from './codex-feedback-client.ts';
import redactCodexFeedback from './codex-feedback-redaction.ts';
import { requireWorkflowSchedule } from './workflow-result.ts';
import runCodexFeedback from './codex-feedback.ts';
import codexCapacity, { codexUnresolvedRetirement } from './codex-capacity.ts';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { inspectActiveIssue, inspectAdmittedIssue } from './dispatch-assignment.ts';
import dispatchContext from './dispatch-context.ts';
import validateDispatchRequest from './codex-dispatch-request.ts';
import { dispatchCheckDigest } from './codex-dispatch-check.ts';
import recoverDispatch from './codex-dispatch-recovery.ts';
import reportDispatch from './codex-dispatch-reporting.ts';
import pendingDispatchAssignments, { issueKey } from './dispatch-pending.ts';
import codexHostAccess from './codex-host-access.ts';
import codexRuntimeInstructions from './codex-runtime-instructions.ts';

import { selectWorkflowStage } from './workflow-stage.ts';
import recordDispatchResult from './dispatch-result.ts';
import codexAssessmentInstructions, {
  autoAssessmentInstructions,
} from './codex-assessment-instructions.ts';
import {
  assessmentDecisionMode,
  assessmentResultContextSchema,
  parseAssessmentResult,
  type AssessmentResult,
} from './assessment-result.ts';
import { automationHash } from './automation-hash.ts';
import codexIssueNotice from './codex-issue-notice.ts';
import { nativeObject } from './automation-gateway.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import { codexIntakePolicy } from './codex-intake-policy.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import {
  dispatchGit,
  resolveDispatchProject,
  verifyDispatchWorktree,
  type DispatchGit,
} from './codex-dispatch-project.ts';
import prepareDispatchRepository from './codex-dispatch-repository.ts';
import { RepositoryPreparationError } from '../tools/git/repository-service.ts';
import resolveGitWorktreeLayout from '../tools/git/worktree-layout.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';
import CodexDispatchStore, { type DispatchRecord } from './codex-dispatch-state.ts';
import {
  connectCodexGitHub,
  selectCodexIntake,
  type CodexIntakeDependencies,
} from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { assessmentSchema } from './model-routing.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import assignmentCard from '../channels/github/presentation/assignment-card.ts';
import assessmentPresentation from './dispatch-presentation.ts';
import {
  githubNotificationMarkdownText,
  githubNotificationQuote,
} from '../channels/github/presentation/card.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';

type Client = GitHubNotificationIntakeClient & GitHubNotificationItemContextClient;
type Selection = Awaited<ReturnType<typeof selectCodexIntake>>;
type Native = ReturnType<typeof codexDispatchNative>;
export interface CodexDispatchDependencies extends Omit<CodexIntakeDependencies, 'connect'> {
  connect?: (workspace: string, signal: AbortSignal) => Promise<Client>;
  activation?: typeof inspectCodexDispatchActivation;
  native?: Native;
  git?: DispatchGit;
  feedbackConnect?: typeof connectCodexFeedback;
  summaryAuthority?: (threadId: string, turnId: string) => Promise<void>;
  prepareRepository?: typeof prepareDispatchRepository;
  retirementNative?: ReturnType<typeof codexRetirementNative>;
  threadId?: string;
}

function repository(record: IntakeRecord) {
  return record.repository.owner.login + '/' + record.repository.name;
}
function issueUrl(record: IntakeRecord) {
  return 'https://github.com/' + repository(record) + '/issues/' + record.issue.number;
}
function code(error: unknown) {
  if (codexHostAccess(error)) return 'codex-host-access-required';
  return workflowFailure(error, 'dispatch-operation-failed').code;
}
function remediation(value: string) {
  const recovery = workflowRecovery(value);
  if (recovery) return recovery.next;
  if (value === 'dispatch-native-receipt-reused')
    return "This native receipt belongs to another assessment, including a retired attempt. Reconcile only the receipt returned by this prepared request's create_thread call, or omit receipt to recover its actual creation. Do not create again or reuse history.";
  if (value.startsWith('dispatch-assessment-skill-'))
    return 'Check issue-assignment.assessment.skill against the enabled Codex skills. Use a qualified plugin:skill id to resolve ambiguity, and restore the selected skill if it changed. Retry this retained assignment or resume its existing chat; do not create a replacement chat.';
  if (value.startsWith('dispatch-assessment-guidance-'))
    return 'Correct issue-assignment.assessment.guidance: use nonempty text or a readable UTF-8 file within the bound agent workspace, without symlinks, up to 32 KiB. Retry the retained assignment after restoring the guidance; live edits apply without Install.';
  if (value === 'dispatch-configured-project-missing')
    return 'The explicitly configured local repository path is missing. Correct or remove its git.worktrees.repositories.local override, keep the repository registered as a saved Codex project, and let the next scheduled occurrence retry this retained assignment.';
  if (value.includes('project'))
    return 'Add the exact repository checkout as one saved Git-backed Codex project, resolve any path or origin conflict, then let the next scheduled occurrence retry this retained assignment.';
  if (value.includes('activation'))
    return 'Authorize Install to reconcile the updated assignment schedule, then verify its saved state. Existing intake consent alone does not authorize dispatch.';
  if (value === 'dispatch-mode-unsupported')
    return 'Set issue-assignment mode to plan, work, or auto, then retry with the live manifest. Other modes cannot dispatch issue assessments.';
  if (value.includes('routing') || value.includes('model'))
    return 'Inspect the retained routing evidence and configured profiles. Repair the selection or native model access; do not substitute a model or recreate the chat.';
  if (value.includes('authority') || value.includes('policy') || value.includes('binding'))
    return 'Restore current issue assignment, repository access, and configured authority before retrying. Retain the existing chat and evidence.';
  if (value.includes('result'))
    return 'Inspect the retained issue chat and its failure or interruption. Resume that same chat to finish the assessment and submit its structured result; do not launch a replacement.';
  return 'Inspect this operation and the retained native creation receipt, chat, and worktree. Resolve the reported condition, then reconcile the existing creation; never repeat an uncertain create or change credentials without evidence of an authentication failure.';
}
function blocker(
  record: DispatchRecord,
  value: string,
  error?: unknown,
  repositoryId?: number,
): AssessmentResult {
  const preparation = record.repositoryPreparation;
  const path =
    error instanceof RepositoryPreparationError
      ? error.path
      : (preparation?.checkout ?? preparation?.path);
  const detail = path
    ? ' Repository: ' +
      githubNotificationMarkdownText(
        preparation?.identity ??
          (error instanceof RepositoryPreparationError ? (error.identity ?? '') : ''),
      ) +
      '. Path: ' +
      githubNotificationMarkdownText(path) +
      '.'
    : '';
  const action =
    value === 'dispatch-project-registration-unavailable'
      ? 'No supported native project registration action is available. Add this exact checkout as the primary folder of one saved local Codex project, then let the next scheduled occurrence verify it and resume the retained assignment.'
      : value === 'repository-preparation-changed'
        ? 'This assignment or interrupted clone is pinned to its retained repository location. Restore the previous working-directory and roots. For a normal checkout outside the managed roots, you can instead set git.worktrees.repositories.local.' +
          (repositoryId === undefined
            ? 'github-<repository-database-id>'
            : 'github-' + repositoryId) +
          ' to ' +
          githubNotificationMarkdownText(JSON.stringify(preparation?.path ?? path)) +
          '. If the base checkout location changed, restore the previous worktree root too. Verify the retained checkout, then let the next scheduled occurrence resume this assignment. New assignments may use a different configured location; do not delete the retained journal or checkout.'
        : value === 'repository-clone-interrupted'
          ? 'Inspect this retained temporary clone. Repair it, or remove only this confirmed preparation-owned temporary directory, then retry; the runtime will not clone over it.'
          : value.startsWith('repository-')
            ? 'Resolve the repository path or identity conflict, or restore access. Use an explicit local repository mapping for same-name repositories. Do not overwrite user work or change storage to bypass the failure.'
            : remediation(value);
  return {
    version: 1,
    outcome: 'operator-setup-blocker',
    code: value,
    summary: 'The issue assessment needs setup or recovery.',
    remediation:
      (workflowRecovery(value, workflowFailure(error, value).providerDiagnostic)?.next ?? action) +
      detail,
    evidence: [{ source: 'Agent System dispatch', status: 'observed', detail: value }],
    progress: record.result?.progress ?? {
      completed: record.threadId ? ['Retained native issue chat ' + record.threadId + '.'] : [],
      remaining: ['Finish assessment in the verified issue worktree.'],
    },
  };
}
function notice(record: DispatchRecord, intake?: IntakeRecord) {
  const failure =
    !record.effective && record.result?.outcome === 'operator-setup-blocker'
      ? record.result
      : undefined;
  return {
    id: record.id,
    status: record.handoff ? 'handed-off' : record.phase,
    workflowStatus: workflowStatus(record),
    changed: Boolean(record.dispatchedAt && !record.intakeReportedAt) || Boolean(failure),
    threadId: record.threadId,
    ...(failure
      ? {
          code: failure.code,
          ...codexIssueNotice({
            event: 'failure',
            changed: true,
            code: failure.code,
            ...(intake
              ? {
                  issue: {
                    label: repository(intake) + '#' + intake.issue.number,
                    url: issueUrl(intake),
                  },
                }
              : {}),
            actionMarkdown: failure.remediation,
            facts:
              failure.code === 'dispatch-project-registration-unavailable' &&
              record.repositoryPreparation?.checkout
                ? [
                    {
                      label: 'Project name',
                      value: intake
                        ? githubNotificationMarkdownText(intake.repository.name)
                        : 'Repository',
                    },
                    {
                      label: 'Folder path',
                      value: githubNotificationMarkdownText(record.repositoryPreparation.checkout),
                    },
                  ]
                : [],
          }),
        }
      : {}),
    nextAction: 'next',
    instruction: failure
      ? 'Continue next for unrelated eligible assignments, then report this intake obstacle with any issues already started. Do not repeat an uncertain creation.'
      : 'Continue checking pending assignments while this run has capacity. Assessment progress belongs only in the issue.',
  };
}

export async function revalidateDispatchAssignment(
  current: Selection,
  record: IntakeRecord,
  deps: CodexDispatchDependencies,
  signal: AbortSignal,
  retainedWork = false,
) {
  const client = await (deps.connect ?? connectCodexGitHub)(current.workspace, signal);
  const repo = retainedWork
    ? (await inspectActiveIssue(record, client)).repo
    : (await inspectAdmittedIssue(record, client)).repo;
  return { client, repo };
}

async function withNative<T>(
  current: Selection,
  deps: CodexDispatchDependencies,
  run: (native: Native) => Promise<T>,
) {
  if (deps.native) return run(deps.native);
  const connection = await connectCodexThreads(current.workspace, current.codexHome);
  try {
    return await run(codexDispatchNative(connection.request));
  } finally {
    await connection.close();
  }
}

async function recover(
  current: Selection,
  record: DispatchRecord,
  intake: IntakeRecord,
  deps: CodexDispatchDependencies,
  save: () => Promise<void>,
  threadId = record.threadId ?? record.receiptThreadId,
) {
  if (!record.request || !record.project) throw new Error('dispatch-creation-not-prepared');
  const found = await withNative(current, deps, (native) =>
    native.find({
      sourceThreadId: record.sourceThreadId,
      prompt: record.request!.prompt,
      createdAfter: record.createdAt,
      ...(threadId ? { threadId } : {}),
    }),
  );
  if (!found) throw new Error('dispatch-creation-unresolved');
  // identity is retained even when later workspace or model verification fails.
  record.threadId = found.id;
  record.worktree = found.cwd;
  await save();
  await verifyDispatchWorktree(record.project, found.cwd, repository(intake), deps.git);
  if (
    (found.model && found.model !== record.request.model) ||
    (found.effort && found.effort !== record.request.thinking)
  )
    throw new Error('dispatch-native-model-diverged');
  // native titles may be edited independently of the retained issue identity.
  if (!record.effective) record.dispatchedAt = (deps.now ?? Date.now)();
  record.effective = {
    status: found.model && found.effort ? 'verified' : 'unverified',
    ...(found.model ? { model: found.model } : {}),
    ...(found.effort ? { effort: found.effort } : {}),
  };
  record.phase = record.phase === 'complete' ? 'complete' : 'assessing';
  if (record.phase !== 'complete' && record.result?.outcome === 'operator-setup-blocker') {
    delete record.result;
    delete record.stageReceipt;
  }
  return found;
}

function launchPrompt(record: DispatchRecord, intake: IntakeRecord) {
  const card = assignmentCard(
    {
      emoji: '📥',
      item: {
        kind: 'Issue',
        label: repository(intake) + '#' + intake.issue.number,
        url: issueUrl(intake),
      },
      sender: {
        label: intake.assignment.actor.login,
        url: 'https://github.com/' + intake.assignment.actor.login,
      },
    },
    'Assess the requested outcome and prepare a plan. Stop before implementation. After recording and presenting the complete assessment, follow the host-verified summary operation for its bounded GitHub comment.',
  );
  return [
    card,
    'Creation attempt: ' +
      ((record.deniedCreations?.length ?? 0) + (record.unsubmittedCreations?.length ?? 0) + 1) +
      '.',
    'Before investigation, execute dispatchRuntime.argvPrefix from the newest trusted Agent System context followed by context --plugin-data and dispatchRuntime.pluginData. Send ' +
      JSON.stringify({ action: 'context', id: record.id }) +
      ' as JSON on stdin. Investigate only after status verified, following its instructions and selected assessment skill. Preserve the saved model and effort. Use the following transport and recovery rules for context and result submission.',
    codexRuntimeInstructions,
  ].join('\n\n');
}

/** authorized scheduled dispatch only; host tools execute the one durably prepared native request. */
export async function runCodexDispatch(
  pluginData: string,
  action: string,
  input: unknown,
  deps: CodexDispatchDependencies = {},
) {
  validateDispatchRequest(action, input);
  if (action === 'next') {
    const retirement = await reconcileCodexLifecycle(pluginData, deps, input.threads);
    if (retirement) return retirement;
    const feedback = await runCodexFeedback(pluginData, { action: 'next' }, deps);
    if (!['idle', 'disabled'].includes(feedback.status)) return feedback;
  }
  const current = await selectCodexIntake(pluginData, deps);
  const retainedAdmission = await current.store.read();
  if (retainedAdmission?.records.length)
    current.policy ??= retainedIntakePolicy(current.manifest, retainedAdmission, 'codex');
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  if (action === 'inspect') {
    const state = await store.read();
    return {
      ...state,
      records: state.records.map((record) => ({
        ...record,
        workflowStatus: workflowStatus(record),
      })),
    };
  }
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('dispatch-native-caller-required');
  if (action === 'present') {
    const record = (await store.read()).records.find((entry) => entry.id === input.id);
    const intake = (await current.store.read())?.records.find(
      (entry) => entry.id === record?.intakeId,
    );
    if (
      !record?.request ||
      !record.result ||
      !record.threadId ||
      record.threadId !== caller ||
      !intake
    )
      throw new Error('dispatch-assessment-caller-mismatch');
    return withNative(current, deps, async (native) => {
      const found = await native.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request!.prompt,
        createdAfter: record.createdAt,
        threadId: record.threadId,
      });
      if (!found || found.id !== caller) throw new Error('dispatch-native-binding-mismatch');
      return {
        status: 'presented',
        retained: true,
        id: record.id,
        presentation: assessmentPresentation(record.result!, record, intake, current.workspace, {
          debug: current.manifest.debug,
        }),
        instruction:
          'Show this complete saved assessment. This read does not authorize assessment, implementation, or publication.',
      };
    });
  }
  if (action === 'handoff') {
    return store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === input.id);
      if (
        !record?.request ||
        !record.project ||
        !record.threadId ||
        !record.worktree ||
        record.reset ||
        record.retired ||
        record.retirement
      )
        throw new Error('dispatch-handoff-unavailable');
      if (
        caller === record.sourceThreadId ||
        state.records.some(
          (entry) =>
            entry.id !== record.id && [entry.threadId, entry.receiptThreadId].includes(caller),
        )
      )
        throw new Error('dispatch-handoff-caller-mismatch');
      const admitted = await current.store.read();
      const intake = admitted?.records.find((entry) => entry.id === record.intakeId);
      if (!intake) throw new Error('dispatch-intake-record-missing');
      const native = await withNative(current, deps, (host) =>
        host.find({
          sourceThreadId: record.sourceThreadId,
          prompt: record.request!.prompt,
          createdAfter: record.createdAt,
          threadId: record.threadId,
        }),
      );
      if (
        !native ||
        native.id !== record.threadId ||
        (await realpath(native.cwd)) !== (await realpath(record.worktree))
      )
        throw new Error('dispatch-native-readback-diverged');
      await verifyDispatchWorktree(
        record.project,
        native.cwd,
        repository(intake),
        deps.git,
        'handoff',
      );
      const retainedAssessment = record.result ? { previousResult: record.result } : {};
      if (record.handoff)
        return {
          status: 'handed-off',
          changed: false,
          id: record.id,
          threadId: record.threadId,
          ...retainedAssessment,
        };
      if (record.continuation?.phase === 'cancelled') throw new Error('implementation-cancelled');
      if (
        record.continuation?.phase === 'blocked' &&
        (['continuation-native-send-failed', 'continuation-native-approval-denied'].includes(
          record.continuation.code ?? '',
        ) ||
          (record.continuation.result?.outcome === 'blocked' &&
            (!native.followUpUserTurn ||
              native.turnId ===
                (record.continuation.blockedTurnId ??
                  record.continuation.activeTurnId ??
                  record.continuation.binding?.turnId))))
      )
        throw new Error(record.continuation.code ?? 'continuation-implementation-blocked');
      const transition = issueProgression(record, {
        mode: current.manifest.github?.notifications?.issueAssignment?.mode ?? 'plan',
        now: (deps.now ?? Date.now)(),
        operator: native.followUpUserTurn,
      });
      if (!native.turnId || (!native.followUpUserTurn && transition.status !== 'ready'))
        throw new WorkflowPolicyHeld(
          transition.status === 'ready' ? 'native-turn-unavailable' : transition.reason,
        );
      // polling and presentation do not change the work being handed off; retain all authority and result fields.
      const digest = automationHash({
        record: {
          ...record,
          feedback: undefined,
          notice: undefined,
          intakeReportedAt: undefined,
          renameRequested: undefined,
        },
        turnId: native.turnId,
      });
      if (input.digest === undefined)
        return {
          status: 'handoff-available',
          id: record.id,
          digest,
          threadId: record.threadId,
          ...retainedAssessment,
          instruction:
            'Apply this handoff when the live workflow or explicit user request permits implementation. It records the transition and preserves the assessment and checkout. Implementation includes ordinary PR delivery; honor explicit restrictions and native denials.',
        };
      if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
      if (transition.status === 'ready') record.progression = transition.progression;
      record.handoff = { at: (deps.now ?? Date.now)(), by: caller, turnId: native.turnId };
      const response = notice(record, intake);
      await save();
      return { ...response, ...retainedAssessment };
    }, true);
  }
  const operatorRecovery = action === 'retry-denied';
  const operatorReset = action === 'reset';
  const operatorRetire = action === 'retire';
  const operatorAction = operatorRecovery || operatorReset || operatorRetire;
  const childAction = action === 'context' || action === 'result' || action === 'summary';
  const retainedWork = childAction || action === 'reconcile' || action === 'report';
  if (!retainedWork && !current.policy) throw new Error('dispatch-policy-disabled');
  const activation = await (deps.activation ?? inspectCodexDispatchActivation)(
    pluginData,
    { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
    operatorRecovery,
    true,
  );
  if (operatorAction && caller === activation.sourceThreadId)
    throw new Error('dispatch-operator-caller-required');
  if (!operatorAction && !childAction && caller !== activation.sourceThreadId)
    throw new Error('dispatch-intake-caller-required');
  const admitted = await current.store.read();
  if (!admitted) throw new Error('dispatch-policy-reconciliation-required');
  const now = (deps.now ?? Date.now)();
  const waitForLock = childAction || action === 'report';
  return store
    .exclusive(async (state, save, signal) => {
      if (!operatorAction && !childAction) {
        const occurrence = await withNative(current, deps, (host) => host.occurrence(caller));
        if (state.run?.id !== occurrence.id) {
          state.run = { ...occurrence, actions: 0 };
          delete state.checked;
        }
        if (action !== 'report') {
          if (state.run.actions >= 12) {
            await save();
            return { status: 'budget-exhausted', changed: false, nextAction: 'report' };
          }
          state.run.actions++;
        }
        await save();
      }
      const fresh = async () => {
        const selected = await selectCodexIntake(pluginData, deps);
        const allowed = await (deps.activation ?? inspectCodexDispatchActivation)(
          pluginData,
          { codexHome: selected.codexHome, inspectBinding: deps.inspectBinding },
          operatorRecovery,
          true,
        );
        if (
          selected.store.location.scope !== current.store.location.scope ||
          allowed.sourceThreadId !== activation.sourceThreadId
        )
          throw new Error('dispatch-workspace-binding-changed');
      };
      const fail = async (record: DispatchRecord, error: unknown) => {
        if (error instanceof WorkflowPolicyHeld)
          return { status: 'policy-held', id: record.id, reason: error.reason, nextAction: 'next' };
        if (['dispatch-policy-disabled', 'dispatch-activation-required'].includes(code(error)))
          throw error;
        const previousCode =
          record.result?.outcome === 'operator-setup-blocker' ? record.result.code : undefined;
        if (codexHostAccess(error) || record.phase === 'complete') throw error;
        // Native worktree setup returns a client receipt before the child is readable.
        if (
          code(error) === 'dispatch-creation-unresolved' &&
          record.phase === 'creating' &&
          record.clientThreadId &&
          !record.threadId &&
          !record.receiptThreadId &&
          now < record.createdAt + 300000
        ) {
          record.retryAfter = record.createdAt + 300000;
          await save();
          return { id: record.id, status: 'creating', changed: false };
        }
        record.result = blocker(
          record,
          code(error),
          error,
          admitted.records.find((entry) => entry.id === record.intakeId)?.repository.databaseId,
        );
        record.retryAfter = now + 300000;
        scheduleDispatchRetry(record, code(error), error, now);
        record.phase = dispatchFailurePhase(record, code(error), error);
        if (
          record.phase === 'retrying' &&
          record.retryAfter &&
          record.result.outcome === 'operator-setup-blocker'
        )
          record.result.remediation =
            'Automatic recovery will retry at or after ' +
            new Date(record.retryAfter).toISOString() +
            '. Preserve the retained request; no new stage approval is needed.';
        // an item failure does not end the shared intake occurrence.
        if (state.run) delete state.run.stopped;
        const result = notice(
          record,
          admitted.records.find((entry) => entry.id === record.intakeId),
        );
        Object.assign(result, workflowFailure(error, 'dispatch-operation-failed'));
        result.changed = previousCode !== code(error);
        if ('notify' in result) result.notify = result.changed;
        await save();
        return result;
      };
      if (action === 'report')
        return reportDispatch(input, {
          state,
          admitted,
          intakeStore: current.store,
          now,
          save,
          slots: codexIntakePolicy(current.manifest, true)?.policy.maxConcurrentItems ?? 3,
        });
      if (action === 'next') {
        const scan = await current.store.read();
        if (!scan) throw new Error('dispatch-intake-record-missing');
        const checked = async (status: 'idle' | 'at-capacity') => {
          state.checked = { at: now, digest: dispatchCheckDigest(state, admitted) };
          await save();
          return { status, changed: false };
        };
        // historical custody is observed independently of provider authorization and checkout availability.
        const observations = state.records
          .filter(
            (entry) =>
              entry.request &&
              !entry.handoff &&
              (codexUnresolvedRetirement(entry) ||
                ((entry.threadId || entry.receiptThreadId) &&
                  (['blocked', 'waiting', 'retrying'].includes(entry.phase) ||
                    (entry.continuation &&
                      ['blocked', 'cancelled'].includes(entry.continuation.phase)) ||
                    entry.feedback?.events.some(
                      (event) => event.phase === 'blocked' && event.attempt,
                    )))),
          )
          .sort((a, b) => (a.capacityObservation?.at ?? 0) - (b.capacityObservation?.at ?? 0))
          .filter(
            (entry) =>
              (!entry.retired && !entry.retirement) ||
              !entry.capacityObservation ||
              entry.capacityObservation.at + 300000 <= now,
          )
          .slice(0, 12);
        for (const record of observations) {
          try {
            await withNative(current, deps, (native) =>
              reconcileCodexCapacity(record, native, state.run!.id, now),
            );
          } catch (error) {
            // failure to open the native reader neither proves inactivity nor stops unrelated work.
            delete record.nativeInactive;
            record.capacityObservation = {
              ...record.capacityObservation,
              at: now,
              code: workflowFailure(error, 'dispatch-capacity-observation-unavailable').code,
            };
          }
        }
        if (observations.length) await save();
        for (const pending of state.records.filter(
          (record) =>
            !record.retired &&
            !record.retirement &&
            !record.handoff &&
            record.request &&
            !record.effective &&
            record.phase !== 'complete' &&
            (record.phase !== 'blocked' ||
              (record.result?.outcome === 'operator-setup-blocker' &&
                [
                  'dispatch-assignment-superseded',
                  'dispatch-assignment-authority-revoked',
                ].includes(record.result.code))) &&
            (record.retryAfter ?? 0) <= now,
        )) {
          const intake = admitted.records.find((entry) => entry.id === pending.intakeId);
          if (!intake) return fail(pending, new Error('dispatch-intake-record-missing'));
          try {
            await revalidateDispatchAssignment(current, intake, deps, signal);
            await recover(current, pending, intake, deps, save);
            delete pending.retry;
            pending.retryAfter = now + 300000;
            await fresh();
            const result = notice(pending, intake);
            await save();
            if (result.changed || result.status !== 'assessing') return result;
          } catch (error) {
            if (code(error) === 'dispatch-assignment-superseded') {
              try {
                await recover(current, pending, intake, deps, save);
              } catch (recoveryError) {
                if (code(recoveryError) !== 'dispatch-creation-unresolved')
                  return fail(pending, recoveryError);
              }
            }
            if (
              ['dispatch-creation-unresolved', 'dispatch-assignment-superseded'].includes(
                code(error),
              ) &&
              !pending.threadId &&
              !pending.receiptThreadId &&
              !pending.clientThreadId &&
              !pending.worktree &&
              !pending.continuation?.attempt &&
              !pending.continuation?.publicationAttempt
            ) {
              try {
                const proof = await withNative(current, deps, (native) =>
                  native.unsubmittedCreation(
                    pending.sourceThreadId,
                    {
                      createdAt: pending.createdAt,
                      turnId: pending.preparationTurnId,
                      prompt: pending.request!.prompt,
                    },
                    state.run!.id,
                  ),
                );
                if (proof) {
                  await fresh();
                  (pending.unsubmittedCreations ??= []).push({
                    request: pending.request!,
                    createdAt: pending.createdAt,
                    recoveredAt: now,
                    ...(pending.continuation ? { continuation: pending.continuation } : {}),
                    turnId: proof.turnId,
                  });
                  delete pending.continuation;
                  delete pending.request;
                  delete pending.result;
                  delete pending.stageReceipt;
                  delete pending.notice;
                  delete pending.retryAfter;
                  delete pending.preparationTurnId;
                  pending.phase = 'routing';
                  await save();
                  continue;
                }
              } catch (recoveryError) {
                return fail(pending, recoveryError);
              }
            }
            return fail(pending, error);
          }
        }
        if (!codexCapacity(state.records, current.policy?.policy.maxConcurrentItems ?? 3).available)
          return checked('at-capacity');
        const intake = pendingDispatchAssignments(state, admitted, codexUnresolvedRetirement)
          .filter(({ intake }) => !liveWorkflowPolicy(current.manifest, 'codex', intake))
          .find(
            ({ record, intake }) =>
              !record?.request &&
              (record?.phase !== 'blocked' || record.intakeId !== intake.id) &&
              (record?.retryAfter ?? 0) <= now,
          )?.intake;
        if (!intake) return checked('idle');
        let record = state.records.find(
          (entry) =>
            !entry.reset &&
            !entry.retired &&
            !entry.retirement &&
            entry.issueKey === issueKey(intake),
        );
        if (!record) {
          record = {
            id: automationHash([current.store.location.scope, randomUUID()]),
            intakeId: intake.id,
            issueKey: issueKey(intake),
            sourceThreadId: activation.sourceThreadId,
            phase: 'routing',
            createdAt: now,
            feedback: {
              startedAt: now,
              admission: {
                observedAt: now,
                enabled: workflowFeedbackEnabled(
                  current.manifest.github?.notifications,
                  'issue-assignment',
                ),
              },
              baseline: {},
              events: [],
            },
            manifestDigest: current.digest,
          };
          state.records.push(record);
        }
        try {
          record.intakeId = intake.id;
          const { client, repo } = await revalidateDispatchAssignment(
            current,
            intake,
            deps,
            signal,
          );
          const configuration = current.manifest.git?.worktrees ?? {};
          const repositoryId = 'github-' + repo.databaseId;
          const layout = resolveGitWorktreeLayout(current.workspace, configuration);
          const managedCheckout = join(
            layout.worktreeRoot,
            gitWorktreeRepositoryDirectoryName(repositoryId).replace(/\.git$/u, ''),
            'codex-project',
          );
          const explicitPath = Object.hasOwn(layout.localRepositories, repositoryId)
            ? layout.localRepositories[repositoryId]
            : layout.workingDirectory
              ? join(layout.workingDirectory, repo.name)
              : undefined;
          const projectInput = {
            projects: input.projects,
            repository: repository(intake),
            defaultBranch: repo.defaultBranch,
            workspace: current.workspace,
            explicitPath,
          };
          const prepareRepository = async () => {
            await fresh();
            await revalidateDispatchAssignment(current, intake, deps, signal);
            return (deps.prepareRepository ?? prepareDispatchRepository)(
              {
                workspace: current.workspace,
                configuration,
                repositoryId,
                repository: repository(intake),
                cloneUrl: repo.cloneUrl,
                defaultBranch: repo.defaultBranch,
                previous: record.repositoryPreparation,
              },
              {
                git: deps.git,
                signal,
                authorize: fresh,
                retain: async (value) => {
                  record.repositoryPreparation = value;
                  await save();
                },
              },
            );
          };
          let project;
          if (record.repositoryPreparation) projectInput.explicitPath = await prepareRepository();
          try {
            project = await resolveDispatchProject(projectInput, deps.git ?? dispatchGit);
          } catch (error) {
            if (
              !['dispatch-project-missing', 'dispatch-configured-project-missing'].includes(
                code(error),
              ) &&
              !(
                error instanceof RepositoryPreparationError &&
                error.code === 'dispatch-project-workspace-required' &&
                error.path === managedCheckout &&
                !explicitPath
              )
            )
              throw error;
            const checkout = record.repositoryPreparation?.checkout ?? (await prepareRepository());
            try {
              project = await resolveDispatchProject(
                { ...projectInput, explicitPath: checkout },
                deps.git ?? dispatchGit,
              );
            } catch (selectionError) {
              if (code(selectionError) === 'dispatch-project-missing')
                throw new RepositoryPreparationError(
                  'dispatch-project-registration-unavailable',
                  checkout,
                  'github.com/' + repository(intake),
                );
              throw selectionError;
            }
          }
          if (!record.repositoryPreparation && project.path === managedCheckout && !explicitPath) {
            const checkout = await prepareRepository();
            project = await resolveDispatchProject(
              { ...projectInput, explicitPath: checkout },
              deps.git ?? dispatchGit,
            );
          }
          const context = await client.getItemContext(
            repo.owner.login,
            repo.name,
            intake.issue.number,
            'issue',
            true,
          );
          const snapshot = dispatchContext(context, issueUrl(intake), now);
          record.project = project;
          record.context = JSON.stringify(snapshot);
          record.manifestDigest = current.digest;
          record.phase = 'routing';
          delete record.result;
          delete record.stageReceipt;
          await fresh();
          await save();
          return {
            status: 'routing-required',
            changed: true,
            id: record.id,
            context: snapshot,
            assessmentSchema,
            digest: automationHash({
              context: record.context,
              project: record.project,
              manifest: record.manifestDigest,
            }),
            routing: resolveModelRoutingRequest(
              current.manifest.models,
              current.digest,
              { action: 'inspect' },
              'codex',
            ),
          };
        } catch (error) {
          return fail(record, error);
        }
      }
      if (typeof input.id !== 'string') throw new Error('dispatch-request-invalid');
      const record = state.records.find((entry) => entry.id === input.id);
      const intake = record && admitted.records.find((entry) => entry.id === record.intakeId);
      if (!record || !intake) throw new Error('dispatch-receipt-missing');
      if (record.reset) throw new Error('dispatch-assessment-reset');
      if (record.retired && action === 'reconcile') {
        const observation = await withNative(current, deps, (native) =>
          reconcileCodexCapacity(record, native, state.run!.id, now, true),
        );
        await save();
        return {
          id: record.id,
          status: record.nativeInactive ? 'inactive' : 'waiting',
          capacityObservation: observation,
          nextAction: 'next',
        };
      }
      if (record.retired || (record.retirement && !operatorRetire))
        throw new Error('dispatch-assessment-retired');
      if (record.handoff && !operatorRetire) throw new Error('dispatch-assessment-handed-off');
      if (action === 'retire' || action === 'reset' || action === 'retry-denied')
        return recoverDispatch(input, {
          action,
          state,
          record,
          intake,
          sourceThreadId: activation.sourceThreadId,
          manifestDigest: current.digest,
          issueUrl: issueUrl(intake),
          caller,
          now,
          graceMinutes: current.policy?.policy.cleanup?.graceMinutes ?? 60,
          save,
          fresh,
          revalidate: () =>
            revalidateDispatchAssignment(
              current,
              action === 'retry-denied'
                ? (admitted.records.findLast((entry) => issueKey(entry) === record.issueKey) ??
                    intake)
                : intake,
              deps,
              signal,
            ),
          connect: () => (deps.connect ?? connectCodexGitHub)(current.workspace, signal),
          withNative: (operation) => withNative(current, deps, operation),
        });
      if (action === 'prepare') {
        if (record.request) return { status: 'reconcile-required', changed: false, id: record.id };
        if (
          record.phase !== 'routing' ||
          !record.project ||
          !record.context ||
          input.digest !==
            automationHash({
              context: record.context,
              project: record.project,
              manifest: record.manifestDigest,
            })
        )
          throw new Error('dispatch-preparation-stale');
        try {
          await revalidateDispatchAssignment(current, intake, deps, signal);
          const snapshot = JSON.parse(record.context);
          const metadata = snapshot.metadata?.complexity;
          const decision = resolveModelRoutingRequest(
            current.manifest.models,
            current.digest,
            {
              action: 'resolve',
              manifestDigest: current.digest,
              context:
                record.context.slice(0, 17950) +
                '\n[Bounded routing snapshot; full evidence retained.]',
              assessment: input.assessment,
              ...(metadata?.status === 'verified'
                ? { evidence: { complexity: metadata.value, source: metadata.source } }
                : {}),
              ...(input.fallback ? { fallback: input.fallback } : {}),
            },
            'codex',
          );
          if (!('candidate' in decision) || decision.candidate?.status !== 'mapped')
            throw new Error('dispatch-routing-unresolved');
          const live = await selectCodexIntake(pluginData, deps);
          const held = liveWorkflowPolicy(live.manifest, 'codex', intake);
          if (held) throw new WorkflowPolicyHeld(held);
          current.manifest = live.manifest;
          current.policy = live.policy;
          const configuration = live.policy?.policy.issueAssignment?.assessment;
          const selected = await selectWorkflowStage({
            stage: 'assessment',
            configuration,
            workspace: current.workspace,
            observedAt: now,
            resolveSkill: (id) =>
              withNative(current, deps, (native) =>
                native.assessmentSkill(record.project!.path, id),
              ),
          });
          record.assessment = selected.selection;
          record.issueMode =
            current.manifest.github?.notifications?.issueAssignment?.mode ?? 'plan';
          if (record.issueMode === 'work' || record.issueMode === 'auto') {
            await (deps.activation ?? inspectCodexDispatchActivation)(
              pluginData,
              { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
              false,
              true,
              'implementation',
            );
            const implementation = await selectWorkflowStage({
              stage: 'implementation',
              configuration: current.policy!.policy.issueAssignment!.implementation,
              workspace: current.workspace,
              observedAt: now,
              resolveSkill: (id) =>
                withNative(current, deps, (host) => host.assessmentSkill(record.project!.path, id)),
            });
            record.continuation = {
              phase: 'waiting',
              policyDigest: notificationAuthorityDigest(current.manifest.github?.notifications),
              selection: implementation.selection,
            };
          }
          record.routing = JSON.stringify(decision);
          record.routingNote = githubNotificationQuote(
            '## 🧠 Model routing\n\n' +
              decision.candidate.model +
              ' / ' +
              decision.candidate.thinking +
              ' — ' +
              decision.complexity +
              ' complexity (' +
              decision.source +
              '). ' +
              decision.reason +
              ' Requested selection; effective settings await native verification.',
          );
          record.createdAt = now;
          record.preparationTurnId = state.run!.id;
          delete record.retry;
          delete record.retryAfter;
          record.reservationVersion = 1;
          delete record.capacityObservation;
          delete record.nativeInactive;
          record.request = {
            title: '#' + intake.issue.number + ': ' + (input.title as string).trim().toUpperCase(),
            prompt: launchPrompt(record, intake),
            model: decision.candidate.model,
            thinking: decision.candidate.thinking,
            target: {
              type: 'project',
              projectId: record.project.id,
              environment: {
                type: 'worktree',
                startingState: { type: 'branch', branchName: record.project.commit },
              },
            },
          };
          record.phase = 'creating';
          await fresh();
          await save();
          return {
            status: 'prepared',
            changed: true,
            id: record.id,
            request: record.request,
            instruction:
              'Next, call native create_thread once with this request unchanged. Do not call prepare again to retrieve or reauthorize it. In a code orchestration tool, parse this response and pass its request object directly to create_thread; do not reconstruct the prompt. Reconcile only the receipt returned by that call, never one from history or another assessment, even for the same issue. If the call fails or its outcome is unknown, reconcile without a receipt; never repeat an uncertain creation.',
            ...(record.deniedCreations?.length
              ? {
                  recovery: {
                    status: 'verified-denial',
                    previousAttempt: {
                      turnId: record.deniedCreations.at(-1)!.turnId,
                      callId: record.deniedCreations.at(-1)!.callId,
                      recoveredAt: record.deniedCreations.at(-1)!.recoveredAt,
                      approvedBy: record.deniedCreations.at(-1)!.approvedBy,
                    },
                    instruction:
                      'The operator recovered a verified non-executed denial. This is a new prepared request, not a replay of an uncertain creation. Execute this exact request at most once.',
                  },
                }
              : {}),
          };
        } catch (error) {
          return fail(record, error);
        }
      }
      if (action === 'reconcile' || childAction) {
        try {
          if (action === 'reconcile' && input.receipt !== undefined) {
            if (
              !nativeObject(input.receipt) ||
              Object.keys(input.receipt).some(
                (key) => !['threadId', 'clientThreadId', 'hostId'].includes(key),
              ) ||
              (input.receipt.hostId !== undefined && input.receipt.hostId !== 'local')
            )
              throw new Error('dispatch-native-receipt-invalid');
            for (const key of ['threadId', 'clientThreadId'] as const) {
              const value = input.receipt[key];
              if (value !== undefined) {
                if (
                  typeof value !== 'string' ||
                  !value ||
                  value.length > 4096 ||
                  (record[key === 'threadId' ? 'receiptThreadId' : key] &&
                    record[key === 'threadId' ? 'receiptThreadId' : key] !== value)
                )
                  throw new Error('dispatch-native-receipt-invalid');
                if (
                  state.records.some(
                    (other) =>
                      other.id !== record.id &&
                      [other.threadId, other.receiptThreadId, other.clientThreadId].includes(value),
                  )
                )
                  throw new Error('dispatch-native-receipt-reused');
              }
            }
            // validate the entire receipt before retaining either identity.
            if (input.receipt.threadId !== undefined)
              record.receiptThreadId = input.receipt.threadId as string;
            if (input.receipt.clientThreadId !== undefined)
              record.clientThreadId = input.receipt.clientThreadId as string;
            await save();
          }
          if (childAction && record.threadId && record.threadId !== caller)
            throw new Error('dispatch-assessment-caller-mismatch');
          await revalidateDispatchAssignment(current, intake, deps, signal, true);
          const native = await recover(
            current,
            record,
            intake,
            deps,
            save,
            childAction ? caller : (record.threadId ?? record.receiptThreadId),
          );
          await fresh();
          if (action === 'context')
            record.issueMode =
              current.manifest.github?.notifications?.issueAssignment?.mode ?? 'plan';
          if (action === 'summary') {
            if (!record.result || !native.turnId)
              throw new Error('assessment-summary-source-unavailable');
            const activate = () =>
              (deps.activation ?? inspectCodexDispatchActivation)(
                pluginData,
                { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
                false,
                true,
                'assessment-summary',
              );
            const summaryAuthority = await activate();
            if (!summaryAuthority.schedule)
              throw new Error('workflow-schedule-reconciliation-required');
            requireWorkflowSchedule(
              summaryAuthority.schedule.saved,
              summaryAuthority.schedule.current,
              'assessment-summary',
            );
            const authorityDigest = automationHash(summaryAuthority.schedule);
            return assessmentSummary({
              record,
              intake,
              action: input as unknown as AssessmentSummaryRequest,
              turnId: native.turnId,
              authorityDigest,
              presentation: assessmentPresentation(
                record.result,
                record,
                intake,
                current.workspace,
                { debug: current.manifest.debug },
              ),
              save,
              redact: redactCodexFeedback,
              authorize: async () => {
                await fresh();
                if (input.operation !== 'reconcile') {
                  if (deps.summaryAuthority) await deps.summaryAuthority(native.id, native.turnId!);
                  else {
                    const connection = await connectCodexThreads(
                      current.workspace,
                      current.codexHome,
                    );
                    try {
                      await codexSummaryAuthority(connection.request, native.id, native.turnId!);
                    } finally {
                      await connection.close();
                    }
                  }
                }
                await activate();
                await revalidateDispatchAssignment(current, intake, deps, signal, true);
              },
              select: async (previous) =>
                (
                  await selectFeedbackStage({
                    policy: current.policy!.policy,
                    workflow: 'issue-assignment',
                    workspace: current.workspace,
                    observedAt: previous?.observedAt ?? now,
                    resolveSkill: (id) =>
                      withNative(current, deps, (host) => host.assessmentSkill(native.cwd, id)),
                  })
                ).selection,
              connect: async () => ({
                client: (
                  await (deps.feedbackConnect ?? connectCodexFeedback)(current.workspace, signal)
                ).comments,
              }),
            });
          }
          if (action === 'context') {
            const assessment = (
              await selectWorkflowStage({
                stage: 'assessment',
                configuration: current.manifest.github?.notifications?.issueAssignment?.assessment,
                workspace: current.workspace,
                observedAt: now,
                resolveSkill: (id) =>
                  withNative(current, deps, (host) => host.assessmentSkill(native.cwd, id)),
              })
            ).selection;
            // historical selection remains evidence; each invocation uses live configuration.
            record.assessment ??= assessment;
            await save();
            return {
              status: 'verified',
              id: record.id,
              project: record.project,
              routing: JSON.parse(record.routing!),
              routingNote: record.routingNote,
              effective: record.effective,
              evidence: JSON.parse(record.context!),
              assessment,
              ...(native.turnId ? { currentTurnId: native.turnId } : {}),
              ...(record.result
                ? {
                    previousResult: record.result,
                    previousResultDigest: automationHash(record.result),
                    previousResultTurnId: record.resultTurnId,
                    previousPresentation: assessmentPresentation(
                      record.result,
                      record,
                      intake,
                      current.workspace,
                      {
                        debug: current.manifest.debug,
                        manifestPath:
                          current.manifestSources?.[
                            '/github/notifications/issue-assignment/assessment/guidance'
                          ]?.path ?? current.manifestPath,
                      },
                    ),
                  }
                : {}),
              resultContract: 'assessment-result/v1',
              resultSchema: assessmentResultContextSchema,
              mode: current.manifest.github?.notifications?.issueAssignment?.mode ?? 'plan',
              instructions:
                codexAssessmentInstructions +
                (record.issueMode === 'auto' ? '\n\n' + autoAssessmentInstructions : ''),
            };
          }
          if (action === 'result') {
            const continuation = record.issueMode === 'auto' ? record.continuation : undefined;
            let result: AssessmentResult;
            try {
              result = parseAssessmentResult(input.result);
              if (record.issueMode === 'auto' && !result.decision)
                throw new Error('assessment-decision-required');
              if (
                record.continuation?.assessmentDigest &&
                record.continuation.assessmentDigest !== automationHash(result)
              )
                throw new Error('continuation-assessment-changed');
            } catch (error) {
              if (
                continuation &&
                !['blocked', 'cancelled', 'complete'].includes(continuation.phase)
              ) {
                continuation.phase = 'blocked';
                continuation.code = code(error);
                await save();
              }
              throw error;
            }
            if (!native.turnId) throw new Error('dispatch-native-turn-unavailable');
            recordDispatchResult({
              record,
              intake,
              threadId: native.id,
              turnId: native.turnId,
              worktree: native.cwd,
              policy: current.manifest.github?.notifications,
              result,
              previousResultDigest: input.previousResultDigest as string | undefined,
            });
            if (
              continuation?.phase === 'blocked' &&
              !continuation.assessmentDigest &&
              !continuation.attempt &&
              !continuation.binding &&
              [
                'assessment-result-invalid',
                'assessment-decision-required',
                'assessment-decision-conflict',
              ].includes(continuation.code ?? '')
            ) {
              continuation.phase = 'waiting';
              delete continuation.code;
            }
            if (
              continuation?.phase === 'waiting' &&
              assessmentDecisionMode(result.decision) === 'plan'
            ) {
              continuation.phase = 'blocked';
              continuation.code = 'continuation-auto-wait';
            }
            const presentation = assessmentPresentation(result, record, intake, current.workspace, {
              debug: current.manifest.debug,
              manifestPath:
                current.manifestSources?.[
                  '/github/notifications/issue-assignment/assessment/guidance'
                ]?.path ?? current.manifestPath,
            });
            await save();
            return {
              status: 'recorded',
              id: record.id,
              outcome: result.outcome,
              previousResultDigest: automationHash(result),
              presentation,
              instruction: assessmentSummaryInstructions('codex'),
            };
          }
          const result = notice(record, intake);
          await save();
          return result;
        } catch (error) {
          if (childAction) throw error;
          return fail(record, error);
        }
      }
      throw new Error('dispatch-action-invalid');
    }, waitForLock)
    .catch((error: unknown) => {
      if (nativeObject(error) && error.code === 'private-state-file-lock-busy')
        return {
          status: 'busy',
          changed: false,
          ...(childAction
            ? {
                instruction:
                  'The dispatch journal is temporarily busy. Retry this same request; do not investigate or create another chat.',
              }
            : {}),
        };
      throw error;
    });
}
