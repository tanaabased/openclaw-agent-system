import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { workflowFeedbackEnabled } from '../channels/github/feedback-policy.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import assignmentCard from '../channels/github/presentation/assignment-card.ts';
import { githubNotificationQuote } from '../channels/github/presentation/card.ts';
import { RepositoryPreparationError } from '../tools/git/repository-service.ts';
import resolveGitWorktreeLayout from '../tools/git/worktree-layout.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';
import { automationHash } from './automation-hash.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import reconcileCodexCapacity from './codex-capacity-reconcile.ts';
import codexCapacity, { codexUnresolvedRetirement } from './codex-capacity.ts';
import { dispatchCheckDigest } from './codex-dispatch-check.ts';
import {
  code,
  issueUrl,
  repository,
  revalidateDispatchAssignment,
  withNative,
  type CodexDispatchDependencies,
  type CodexDispatchTransaction,
  type CodexDispatchSelection as Selection,
} from './codex-dispatch-context.ts';
import {
  dispatchGit,
  resolveDispatchProject,
  verifyDispatchWorktree,
} from './codex-dispatch-project.ts';
import { failDispatch, notice } from './codex-dispatch-reporting.ts';
import prepareDispatchRepository from './codex-dispatch-repository.ts';
import { type DispatchRecord } from './codex-dispatch-state.ts';
import { selectCodexIntake } from './codex-intake.ts';
import codexRuntimeInstructions from './codex-runtime-instructions.ts';
import dispatchContext from './dispatch-context.ts';
import pendingDispatchAssignments, { issueKey } from './dispatch-pending.ts';
import liveWorkflowPolicy, { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import { assessmentSchema } from './model-routing.ts';
import { notificationAuthorityDigest } from './notification-authority.ts';
import workflowFailure from './workflow-failure.ts';
import { selectWorkflowStage } from './workflow-stage.ts';

export async function recover(
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
    'Assess the requested outcome and prepare a plan. After recording and presenting it, handle its host-verified summary and follow the returned handoff in this same turn.',
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

export async function nextDispatch(input: Record<string, unknown>, tx: CodexDispatchTransaction) {
  const { current, deps, state, admitted, activation, now, signal, save, fresh } = tx;
  const fail = (record: DispatchRecord, error: unknown) => failDispatch(record, error, tx);
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
              (entry.continuation && ['blocked', 'cancelled'].includes(entry.continuation.phase)) ||
              entry.feedback?.events.some((event) => event.phase === 'blocked' && event.attempt)))),
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
          ['dispatch-assignment-superseded', 'dispatch-assignment-authority-revoked'].includes(
            record.result.code,
          ))) &&
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
        ['dispatch-creation-unresolved', 'dispatch-assignment-superseded'].includes(code(error)) &&
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
      !entry.reset && !entry.retired && !entry.retirement && entry.issueKey === issueKey(intake),
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
    const { client, repo } = await revalidateDispatchAssignment(current, intake, deps, signal);
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
      status: 'routing-required' as const,
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
export async function prepareDispatch(
  input: Record<string, unknown>,
  record: DispatchRecord,
  intake: IntakeRecord,
  tx: CodexDispatchTransaction,
) {
  const { pluginData, current, deps, state, now, signal, save, fresh } = tx;
  const fail = (record: DispatchRecord, error: unknown) => failDispatch(record, error, tx);
  if (record.request)
    return { status: 'reconcile-required' as const, changed: false, id: record.id };
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
          record.context.slice(0, 17950) + '\n[Bounded routing snapshot; full evidence retained.]',
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
        withNative(current, deps, (native) => native.assessmentSkill(record.project!.path, id)),
    });
    record.assessment = selected.selection;
    record.issueMode = current.manifest.github?.notifications?.issueAssignment?.mode ?? 'auto';
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
      status: 'prepared' as const,
      changed: true,
      id: record.id,
      request: record.request,
      instruction:
        'Next, call native create_thread once with this request unchanged. Do not call prepare again to retrieve or reauthorize it. In a code orchestration tool, parse this response and pass its request object directly to create_thread; do not reconstruct the prompt. Reconcile only the receipt returned by that call, never one from history or another assessment, even for the same issue. If the call fails or its outcome is unknown, reconcile without a receipt; never repeat an uncertain creation.',
      ...(record.deniedCreations?.length
        ? {
            recovery: {
              status: 'verified-denial' as const,
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
