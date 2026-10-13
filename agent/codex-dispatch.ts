import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';

import validateDispatchRequest from './codex-dispatch-request.ts';
import { dispatchCheckDigest } from './codex-dispatch-check.ts';
import recoverDispatch from './codex-dispatch-recovery.ts';
import reportDispatch from './codex-dispatch-reporting.ts';
import pendingDispatchAssignments, { issueKey } from './codex-dispatch-pending.ts';
import codexHostAccess from './codex-host-access.ts';

import { selectWorkflowStage } from './workflow-stage.ts';
import { validateWorkflowResult } from './workflow-result.ts';
import codexAssessmentInstructions from './codex-assessment-instructions.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';
import {
  assessmentResultSchema,
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
import { assessmentSchema, type RoutingDecision } from './model-routing.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import assignmentCard from '../channels/github/conversation/presentation/assignment-card.ts';
import renderAssessmentResult from '../channels/github/conversation/presentation/assessment-result.ts';
import { githubNotificationMarkdownText } from '../channels/github/conversation/presentation/card.ts';
import {
  nativeRoutingMetadata,
  routingMetadata,
} from '../channels/github/provider/routing-metadata.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';
import { defaultAssessmentSkill } from '../manifest/assessment-schema.ts';
import isPathContained from '../utils/is-path-contained.ts';

type Client = GitHubNotificationIntakeClient & GitHubNotificationItemContextClient;
type Selection = Awaited<ReturnType<typeof selectCodexIntake>>;
type Native = ReturnType<typeof codexDispatchNative>;
export interface CodexDispatchDependencies extends Omit<CodexIntakeDependencies, 'connect'> {
  connect?: (workspace: string, signal: AbortSignal) => Promise<Client>;
  activation?: typeof inspectCodexDispatchActivation;
  native?: Native;
  git?: DispatchGit;
  prepareRepository?: typeof prepareDispatchRepository;
  threadId?: string;
}

function repository(record: IntakeRecord) {
  return record.repository.owner.login + '/' + record.repository.name;
}
function issueUrl(record: IntakeRecord) {
  return 'https://github.com/' + repository(record) + '/issues/' + record.issue.number;
}
function assessmentPresentation(
  result: AssessmentResult,
  record: DispatchRecord,
  intake: IntakeRecord,
  workspace: string,
) {
  const decision = JSON.parse(record.routing!) as RoutingDecision;
  return renderAssessmentResult(result, {
    issue: { label: repository(intake) + '#' + intake.issue.number, url: issueUrl(intake) },
    routing: { ...decision, model: record.request!.model, effort: record.request!.thinking },
    effective: record.effective,
    assessment: record.assessment && {
      ...record.assessment,
      guidance: record.assessment.guidance && {
        ...record.assessment.guidance,
        ...(record.assessment.guidance.path
          ? { path: relative(workspace, record.assessment.guidance.path) }
          : {}),
      },
    },
  });
}
function code(error: unknown) {
  if (codexHostAccess(error)) return 'codex-host-access-required';
  const value =
    nativeObject(error) && typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : '';
  return /^[a-z][a-z0-9-]{0,127}$/u.test(value) ? value : 'dispatch-host-unavailable';
}
function remediation(value: string) {
  if (value === 'dispatch-native-receipt-reused')
    return "This native receipt belongs to another assessment, including a retired attempt. Reconcile only the receipt returned by this prepared request's create_thread call, or omit receipt to recover its actual creation. Do not create again or reuse history.";
  if (value.startsWith('dispatch-assessment-skill-'))
    return 'Check issue-assignment.assessment.skill against the enabled Codex skills. Use a qualified plugin:skill id to resolve ambiguity, and restore the selected skill if it changed. Retry this retained assignment or resume its existing chat; do not create a replacement chat.';
  if (value.startsWith('dispatch-assessment-guidance-'))
    return 'Correct issue-assignment.assessment.guidance: use nonempty text or a readable UTF-8 file within the bound agent workspace, without symlinks, up to 32 KiB. Reconcile manifest changes through Install, then retry the retained assignment.';
  if (value === 'dispatch-configured-project-missing')
    return 'The explicitly configured local repository path is missing. Correct or remove its git.worktrees.repositories.local override, keep the repository registered as a saved Codex project, and let the next scheduled occurrence retry this retained assignment.';
  if (value.includes('project'))
    return 'Add the exact repository checkout as one saved Git-backed Codex project, resolve any path or origin conflict, then let the next scheduled occurrence retry this retained assignment.';
  if (value.includes('activation'))
    return 'Authorize Install to reconcile the updated assignment schedule, then verify its saved state. Existing intake consent alone does not authorize dispatch.';
  if (value === 'dispatch-mode-unsupported')
    return 'Set issue-assignment mode to plan or work and reconcile it through authorized Install. Other modes cannot dispatch issue assessments.';
  if (value.includes('routing') || value.includes('model'))
    return 'Inspect the retained routing evidence and configured profiles. Repair the selection or native model access; do not substitute a model or recreate the chat.';
  if (value.includes('authority') || value.includes('policy') || value.includes('binding'))
    return 'Restore current issue assignment, repository access, and configured authority before retrying. Retain the existing chat and evidence.';
  if (value.includes('result'))
    return 'Inspect the retained issue chat and its failure or interruption. Resume that same chat to finish the assessment and submit its structured result; do not launch a replacement.';
  return 'Inspect the retained native creation receipt, chat, and worktree. Restore host access or reconcile the existing creation; never repeat an uncertain create.';
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
          '. If the base checkout location changed, restore the previous worktree root too. Reconcile through Install, then let the next scheduled occurrence resume this assignment. New assignments may use a different configured location; do not delete the retained journal or checkout.'
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
    remediation: action + detail,
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
    nextAction: failure ? 'report' : 'next',
    instruction: failure
      ? 'Report this intake obstacle with any issues already started. Do not repeat an uncertain creation.'
      : 'Continue checking pending assignments while this run has capacity. Assessment progress belongs only in the issue.',
  };
}

export async function revalidateDispatchAssignment(
  current: Selection,
  record: IntakeRecord,
  deps: CodexDispatchDependencies,
  signal: AbortSignal,
  retainedWork = false,
  requireSupportedMode = true,
) {
  const policy = retainedWork ? codexIntakePolicy(current.manifest, true) : current.policy;
  if (
    !policy ||
    (requireSupportedMode && !['plan', 'work'].includes(policy.policy.issueAssignment?.mode ?? ''))
  )
    throw new Error('dispatch-mode-unsupported');
  const client = await (deps.connect ?? connectCodexGitHub)(current.workspace, signal);
  if (
    !githubIdentityMatches(client.identity, record.receiving) ||
    client.identity.login.toLowerCase() !== policy.username.toLowerCase()
  )
    throw new Error('dispatch-receiver-authority-revoked');
  const owner = record.repository.owner.login;
  const name = record.repository.name;
  const repo = await client.getRepository(owner, name);
  const item = await client.getItem(owner, name, record.issue.number);
  const events = await client.listAssignmentEvents(owner, name, record.issue.number);
  if (events.truncated) throw new Error('dispatch-authority-history-incomplete');
  const latest = events.events
    .filter((event) => githubIdentityMatches(event.assignee, client.identity))
    .sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
    )[0];
  if (
    repo.nodeId !== record.repository.nodeId ||
    repo.databaseId !== record.repository.databaseId ||
    repo.archived ||
    repo.disabled ||
    !policy.policy.allowedRepositoryOwners.some((identity) =>
      githubIdentityMatches(identity, repo.owner),
    ) ||
    !githubIdentityMatches(record.repository.owner, repo.owner) ||
    repo.name.toLowerCase() !== name.toLowerCase() ||
    item.nodeId !== record.issue.nodeId ||
    item.databaseId !== record.issue.databaseId ||
    item.number !== record.issue.number ||
    item.itemType !== 'issue' ||
    item.state !== 'open' ||
    !item.assignees.some((identity) => githubIdentityMatches(identity, client.identity)) ||
    !latest ||
    latest.nodeId !== record.assignment.nodeId ||
    latest.event !== 'assigned' ||
    latest.actor.type !== 'User' ||
    !githubIdentityMatches(latest.actor, record.assignment.actor) ||
    !policy.policy.issueAssignment?.allowed.some((identity) =>
      githubIdentityMatches(identity, latest.actor),
    )
  )
    throw new Error('dispatch-assignment-authority-revoked');
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

function sameAssessmentSkill(
  selected: CodexAssessmentSkill,
  current: CodexAssessmentSkill,
  project: string,
  worktree: string,
) {
  const sameSource =
    selected.path === current.path ||
    (selected.scope === 'repo' &&
      current.scope === 'repo' &&
      isPathContained(project, selected.path) &&
      isPathContained(worktree, current.path) &&
      relative(project, selected.path) === relative(worktree, current.path));
  return (
    sameSource &&
    selected.name === current.name &&
    selected.scope === current.scope &&
    selected.digest === current.digest
  );
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
  // titles are presentation, not identity; normalize only after native authority checks.
  if (found.name !== record.request.title)
    await withNative(current, deps, (native) => native.rename(found.id, record.request!.title));
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
    'Assess the requested outcome and prepare a plan. Stop before implementation or GitHub publication.',
  );
  return [
    card,
    'Creation attempt: ' +
      ((record.deniedCreations?.length ?? 0) + (record.unsubmittedCreations?.length ?? 0) + 1) +
      '.',
    'Before investigation, execute dispatchRuntime.argvPrefix from the newest trusted Agent System context followed by --plugin-data and dispatchRuntime.pluginData. Send ' +
      JSON.stringify({ action: 'context', id: record.id }) +
      ' as JSON on stdin using a quoted heredoc or native stdin support. This runtime writes private plugin state. If the filesystem sandbox blocks that access with EPERM or EACCES, request native host approval for this exact fixed command and retry the same request; do not change profile permissions or bypass an approval denial. A busy response is transient: pause briefly and retry the same request up to three times. Investigate only after status verified, following its instructions and selected assessment skill. Preserve the saved model and effort. Stop on an actual verification failure, approval denial, or persistent busy response. Use these same transport and approval rules for result submission.',
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
  const current = await selectCodexIntake(pluginData, deps);
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  if (action === 'inspect') {
    return store.read();
  }
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('dispatch-native-caller-required');
  if (action === 'handoff') {
    return store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === input.id);
      if (
        !record?.request ||
        !record.project ||
        !record.threadId ||
        !record.worktree ||
        record.reset ||
        record.retired
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
      if (!native.turnId || !native.followUpUserTurn)
        throw new Error('dispatch-handoff-user-turn-required');
      const digest = automationHash({ record, manifest: current.digest, turnId: native.turnId });
      if (input.digest === undefined)
        return {
          status: 'handoff-available',
          id: record.id,
          digest,
          threadId: record.threadId,
          ...retainedAssessment,
          instruction:
            'Only after the user requests continuation outside assessment, apply this handoff to end assessment monitoring. It preserves all results and files and grants no implementation or publication authority.',
        };
      if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
      if (record.continuation) record.continuation.phase = 'cancelled';
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
  const childAction = action === 'context' || action === 'result';
  const retainedWork = childAction || action === 'reconcile' || action === 'report';
  if (!retainedWork && !current.policy) throw new Error('dispatch-policy-disabled');
  const activation = await (deps.activation ?? inspectCodexDispatchActivation)(
    pluginData,
    { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
    operatorRecovery || operatorRetire,
    retainedWork,
  );
  if (operatorAction && caller === activation.sourceThreadId)
    throw new Error('dispatch-operator-caller-required');
  if (!operatorAction && !childAction && caller !== activation.sourceThreadId)
    throw new Error('dispatch-intake-caller-required');
  const admitted = await current.store.read();
  if (!admitted || (!retainedWork && admitted.policyDigest !== current.policy?.digest))
    throw new Error('dispatch-policy-reconciliation-required');
  const now = (deps.now ?? Date.now)();
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
          operatorRecovery || operatorRetire,
          retainedWork,
        );
        if (
          selected.digest !== current.digest ||
          selected.store.location.scope !== current.store.location.scope ||
          allowed.sourceThreadId !== activation.sourceThreadId
        )
          throw new Error('dispatch-policy-changed');
      };
      const fail = async (record: DispatchRecord, error: unknown) => {
        if (
          [
            'dispatch-policy-changed',
            'dispatch-policy-disabled',
            'dispatch-activation-required',
          ].includes(code(error))
        )
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
        record.phase = 'blocked';
        record.result = blocker(
          record,
          code(error),
          error,
          admitted.records.find((entry) => entry.id === record.intakeId)?.repository.databaseId,
        );
        record.retryAfter = now + 300000;
        if (state.run) state.run.stopped = 'blocked';
        const result = notice(
          record,
          admitted.records.find((entry) => entry.id === record.intakeId),
        );
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
          slots: codexIntakePolicy(current.manifest, true)?.policy.maxConcurrentItems ?? 2,
        });
      if (action === 'next') {
        const scan = await current.store.read();
        if (!scan) throw new Error('dispatch-intake-record-missing');
        const checked = async (status: 'idle' | 'at-capacity') => {
          state.checked = { at: now, digest: dispatchCheckDigest(state, admitted) };
          await save();
          return { status, changed: false };
        };
        for (const pending of state.records.filter(
          (record) =>
            !record.retired &&
            !record.handoff &&
            record.request &&
            !record.effective &&
            record.phase !== 'complete' &&
            (record.retryAfter ?? 0) <= now,
        )) {
          const intake = admitted.records.find((entry) => entry.id === pending.intakeId);
          if (!intake) return fail(pending, new Error('dispatch-intake-record-missing'));
          try {
            await revalidateDispatchAssignment(current, intake, deps, signal);
            await recover(current, pending, intake, deps, save);
            pending.retryAfter = now + 300000;
            await fresh();
            const result = notice(pending, intake);
            await save();
            if (result.changed || result.status !== 'assessing') return result;
          } catch (error) {
            if (
              code(error) === 'dispatch-creation-unresolved' &&
              !pending.threadId &&
              !pending.receiptThreadId &&
              !pending.clientThreadId &&
              !pending.worktree &&
              (pending.unsubmittedCreations?.length ?? 0) < 8
            ) {
              try {
                const proof = await withNative(current, deps, (native) =>
                  native.unsubmittedCreation(
                    pending.sourceThreadId,
                    { createdAt: pending.createdAt, turnId: pending.preparationTurnId },
                    state.run!.id,
                  ),
                );
                if (proof) {
                  await fresh();
                  (pending.unsubmittedCreations ??= []).push({
                    request: pending.request!,
                    createdAt: pending.createdAt,
                    recoveredAt: now,
                    turnId: proof.turnId,
                  });
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
        if (
          state.records.filter(
            (record) =>
              !record.retired &&
              !record.handoff &&
              record.request &&
              (record.phase !== 'complete' ||
                (record.continuation &&
                  !['complete', 'blocked', 'cancelled'].includes(record.continuation.phase))),
          ).length >= (current.policy?.policy.maxConcurrentItems ?? 1)
        )
          return checked('at-capacity');
        const intake = pendingDispatchAssignments(state, admitted).find(
          ({ record }) => !record?.request && (record?.retryAfter ?? 0) <= now,
        )?.intake;
        if (!intake) return checked('idle');
        let record = state.records.find(
          (entry) => !entry.reset && !entry.retired && entry.issueKey === issueKey(intake),
        );
        if (!record) {
          record = {
            id: automationHash([current.store.location.scope, randomUUID()]),
            intakeId: intake.id,
            issueKey: issueKey(intake),
            sourceThreadId: activation.sourceThreadId,
            phase: 'routing',
            createdAt: now,
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
          const fallbackMetadata = routingMetadata(nativeRoutingMetadata([]), context.body);
          const conflicts = (['complexity', 'workSize'] as const).filter(
            (field) =>
              context.nativeRoutingMetadata?.[field].status === 'verified' &&
              fallbackMetadata[field].status === 'verified' &&
              context.nativeRoutingMetadata[field].value !== fallbackMetadata[field].value,
          );
          const snapshot = {
            source: issueUrl(intake),
            observedAt: now,
            title: context.title.slice(0, 512),
            body: context.body.slice(0, 18000),
            comments: context.comments
              .slice(-10)
              .map((comment) => ({ ...comment, body: comment.body.slice(0, 1200) })),
            metadata: context.routingMetadata ?? null,
            nativeMetadata: context.nativeRoutingMetadata ?? null,
            fallbackMetadata,
            conflicts,
            labels: context.labels,
            truncated:
              context.truncated ||
              context.body.length > 18000 ||
              context.comments.length > 10 ||
              context.comments.some((comment) => comment.body.length > 1200),
          };
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
      if (record.retired) throw new Error('dispatch-assessment-retired');
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
          save,
          fresh,
          revalidate: () => revalidateDispatchAssignment(current, intake, deps, signal),
          connect: () => (deps.connect ?? connectCodexGitHub)(current.workspace, signal),
          withNative: (operation) => withNative(current, deps, operation),
        });
      if (action === 'prepare') {
        if (record.request) return { status: 'reconcile-required', changed: false, id: record.id };
        if (
          record.phase !== 'routing' ||
          !record.project ||
          !record.context ||
          record.manifestDigest !== current.digest ||
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
          const configuration = current.policy?.policy.issueAssignment?.assessment;
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
          if (current.policy?.policy.issueAssignment?.mode === 'work') {
            await (deps.activation ?? inspectCodexDispatchActivation)(
              pluginData,
              { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
              false,
              false,
              'implementation',
            );
            const implementation = await selectWorkflowStage({
              stage: 'implementation',
              configuration: current.policy.policy.issueAssignment.implementation,
              workspace: current.workspace,
              observedAt: now,
              resolveSkill: (id) =>
                withNative(current, deps, (host) => host.assessmentSkill(record.project!.path, id)),
            });
            record.continuation = {
              phase: 'waiting',
              policyDigest: automationHash(current.manifest.github?.notifications),
              selection: implementation.selection,
            };
          }
          record.routing = JSON.stringify(decision);
          record.routingNote =
            '> **Model routing:** ' +
            decision.candidate.model +
            ' / ' +
            decision.candidate.thinking +
            ' — ' +
            decision.complexity +
            ' complexity (' +
            decision.source +
            '). ' +
            decision.reason +
            ' Requested selection; effective settings await native verification.';
          record.createdAt = now;
          record.preparationTurnId = state.run!.id;
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
          if (record.sourceThreadId !== activation.sourceThreadId)
            throw new Error('dispatch-intake-caller-required');
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
          if (action === 'context') {
            // legacy receipts keep their original default, never today's replacement configuration.
            const selected = record.assessment;
            const skill = await withNative(current, deps, (host) =>
              host.assessmentSkill(native.cwd, selected?.skill.name ?? defaultAssessmentSkill),
            );
            if (
              selected &&
              !sameAssessmentSkill(selected.skill, skill, record.project!.path, native.cwd)
            )
              throw new Error('dispatch-assessment-skill-changed');
            record.assessment ??= {
              version: 1,
              requestedSkill: defaultAssessmentSkill,
              defaultSkill: true,
              skill,
              observedAt: now,
            };
            await save();
            return {
              status: 'verified',
              id: record.id,
              project: record.project,
              routing: JSON.parse(record.routing!),
              routingNote: record.routingNote,
              effective: record.effective,
              evidence: JSON.parse(record.context!),
              assessment: { ...record.assessment, skill },
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
                    ),
                  }
                : {}),
              resultContract: 'assessment-result/v1',
              resultSchema: assessmentResultSchema,
              instructions: codexAssessmentInstructions,
            };
          }
          if (action === 'result') {
            const result = parseAssessmentResult(input.result);
            if (!native.turnId) throw new Error('dispatch-native-turn-unavailable');
            const binding = {
              admissionId: intake.id,
              workflow: 'issue-assignment' as const,
              repositoryId: intake.repository.nodeId,
              subjectId: intake.issue.nodeId,
              threadId: native.id,
              turnId: native.turnId,
              worktree: native.cwd,
              dispatchDigest: automationHash(record.request),
              policyDigest: automationHash(current.manifest.github?.notifications ?? null),
              selectionDigest: automationHash(
                record.assessment ?? { skill: defaultAssessmentSkill },
              ),
              routingDigest: automationHash({
                routing: record.routing,
                effective: record.effective,
              }),
              evidenceDigest: automationHash(JSON.parse(record.context!)),
            };
            validateWorkflowResult(
              {
                version: 1,
                stage: 'assessment',
                resultContract: 'assessment-result/v1',
                binding,
                result,
              },
              { binding, stage: 'assessment', authorized: true },
            );
            if (
              record.result &&
              automationHash(record.result) !== automationHash(result) &&
              input.previousResultDigest !== automationHash(record.result)
            )
              throw new Error('assessment-result-conflict');
            const presentation = assessmentPresentation(result, record, intake, current.workspace);
            record.result = result;
            record.stageReceipt = { binding, resultDigest: automationHash(result) };
            record.resultTurnId = native.turnId;
            record.phase = 'complete';
            await save();
            return {
              status: 'recorded',
              id: record.id,
              outcome: result.outcome,
              previousResultDigest: automationHash(result),
              presentation,
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
    }, childAction)
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
