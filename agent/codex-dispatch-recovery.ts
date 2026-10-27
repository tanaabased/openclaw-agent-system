import { type CleanupConfiguration } from './cleanup-configuration.ts';
import { automationHash } from './automation-hash.ts';
import assignmentRetirement from './assignment-retirement.ts';
import type { codexDispatchNative } from './codex-dispatch-native.ts';
import type { DispatchState, DispatchRecord } from './codex-dispatch-state.ts';
import type { ManagedIssue as IntakeRecord } from './managed-issue.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';
import connectCodexGitHubAccount from './codex-github-client.ts';
import IssueDeliveryProvider from '../channels/github/publication/issue-delivery.ts';

type Native = ReturnType<typeof codexDispatchNative>;

export default async function recoverDispatch(
  input: Record<string, unknown>,
  context: {
    action: 'recover' | 'retire' | 'reset' | 'retry-denied';
    state: DispatchState;
    record: DispatchRecord;
    intake: IntakeRecord;
    sourceThreadId: string;
    manifestDigest: string;
    issueUrl: string;
    caller: string;
    now: number;
    readConfiguration(): Promise<CleanupConfiguration>;
    save(): Promise<void>;
    fresh(): Promise<void>;
    revalidate(): Promise<unknown>;
    connect(): Promise<GitHubNotificationIntakeClient>;
    withNative<T>(operation: (host: Native) => Promise<T>): Promise<T>;
    deliveryConnect?: typeof connectCodexGitHubAccount;
  },
) {
  const {
    action,
    state,
    record,
    intake,
    sourceThreadId,
    manifestDigest,
    issueUrl,
    caller,
    now,
    save,
    fresh,
    revalidate,
    connect,
    withNative,
  } = context;
  if (action === 'recover') {
    if (state.records.some((entry) => [entry.threadId, entry.receiptThreadId].includes(caller)))
      throw new Error('dispatch-operator-caller-required');
    const operator = await withNative((host) => host.operatorInput(caller));
    if (record.supersededBy) {
      const successor = state.records.find(
        (entry) => entry.id === record.supersededBy && entry.predecessorId === record.id,
      );
      if (!successor) throw new Error('dispatch-recovery-owner-missing');
      return {
        status: 'recovery-ready',
        id: record.id,
        successorId: successor.id,
        launch: { action: 'launch', operation: 'context', target: issueUrl, id: successor.id },
        instruction:
          'Continue this retained successor through Task Launch; reconcile its prepared native request without creating another successor.',
      };
    }
    await revalidate();
    const blockers = Object.entries({
      nativeTaskMissing: !record.threadId || !record.worktree || !record.request,
      assessmentMissing: !record.result,
      nativeDenial: Boolean(record.denial),
      inactiveLifecycle: Boolean(record.reset || record.retired || record.retirement),
      pendingPush: Boolean(record.delivery?.pendingPush),
      uncertainPrCreation: Boolean(
        record.delivery?.creationAttempted && !record.delivery.pullRequest,
      ),
      uncertainAnnouncement: Boolean(
        record.delivery?.announcement?.attempted && !record.delivery.announcement.receipt,
      ),
      uncertainAssessmentSummary: record.assessmentSummaries?.some(
        (summary) => summary.attempt && !summary.receipt,
      ),
      pendingSummaryTurn: Boolean(record.summaryRecovery && !record.summaryRecovery.ended),
      pendingAutoDecision: Boolean(record.autoDecision && !record.autoDecision.ended),
      unfinishedImplementation: Boolean(
        record.continuation && record.continuation.phase !== 'complete',
      ),
      pendingFeedback: record.feedback?.events.some(
        (event) => !['complete', 'cancelled', 'held'].includes(event.phase),
      ),
    })
      .filter(([, blocked]) => blocked)
      .map(([name]) => name);
    if (blockers.length)
      return {
        status: 'blocked',
        id: record.id,
        code: 'dispatch-recovery-effects-unresolved',
        blockers,
        instruction:
          'Resolve these reported prerequisites through their original native or publication owners before replacement. Preserve native denials and all work; no successor was reserved.',
      };
    const observe = () =>
      withNative((host) =>
        host.find({
          sourceThreadId: record.sourceThreadId,
          prompt: record.request!.prompt,
          createdAfter: record.createdAt,
          threadId: record.threadId,
          observationOnly: true,
        }),
      );
    const native = await observe();
    if (
      !native ||
      native.id !== record.threadId ||
      native.cwd !== record.worktree ||
      native.status !== 'idle' ||
      native.turnStatus !== 'completed' ||
      !native.turnId ||
      !native.turnEnded
    )
      throw new Error('dispatch-recovery-chat-active-or-unverified');
    const connected = await (context.deliveryConnect ?? connectCodexGitHubAccount)(
      intake.workspaceDir,
      AbortSignal.timeout(60000),
    );
    if (connected.account.identity.nodeId !== intake.receiving.nodeId)
      throw new Error('delivery-adoption-account-changed');
    const { repo } = (await revalidate()) as { repo: { defaultBranch: string } };
    const adopted = await new IssueDeliveryProvider(connected.account).adopt(
      {
        repositoryNodeId: intake.repository.nodeId,
        item: {
          number: intake.issue.number,
          itemDatabaseId: intake.issue.databaseId,
          itemNodeId: intake.issue.nodeId,
          repositoryOwner: intake.repository.owner.login,
          repositoryName: intake.repository.name,
          repositoryDefaultBranch: repo.defaultBranch,
        },
      },
      input.pullRequest as string,
    );
    const id = automationHash([record.id, 'recovery']);
    const digest = automationHash({ record, operator, native, adopted, manifestDigest, id });
    await fresh();
    if (input.digest === undefined)
      return {
        status: 'recovery-available',
        id: record.id,
        digest,
        successorId: id,
        issue: issueUrl,
        pullRequest: adopted,
        preserved: { threadId: record.threadId, worktree: record.worktree },
        instruction:
          'Approve this exact replacement with its digest. Preserve old work and history; supersede only this installation’s managed task. No remote computer is disabled and no PR is published.',
      };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
    const latest = await observe();
    const latestOperator = await withNative((host) => host.operatorInput(caller));
    if (
      automationHash(latest) !== automationHash(native) ||
      latestOperator.turnId !== operator.turnId ||
      latestOperator.inputId !== operator.inputId
    )
      throw new Error('dispatch-recovery-stale');
    const manualIssue = {
      version: 1 as const,
      id,
      scope: intake.scope,
      receiving: intake.receiving,
      workspaceDir: intake.workspaceDir,
      agentId: intake.agentId,
      host: intake.host,
      repository: intake.repository,
      issue: intake.issue,
      initiation: {
        kind: 'operator' as const,
        session: caller,
        incarnation: caller,
        turn: operator.turnId,
        input: operator.inputId,
      },
      selections: record.manualIssue?.selections,
      ...(record.manualIssue?.fresh ? { fresh: true as const } : {}),
      evidence: {
        policyDigest: manifestDigest,
        mode: record.issueMode ?? intake.evidence.mode,
        open: true as const,
        repositoryReadable: true as const,
      },
      observedAt: now,
      admittedAt: now,
      status: 'admitted' as const,
      requiresRevalidation: true as const,
    };
    state.records.push({
      id,
      manualIssue,
      issueKey: record.issueKey,
      sourceThreadId: caller,
      phase: 'routing',
      createdAt: now,
      manifestDigest,
      context: record.context,
      predecessorId: record.id,
      adoptedPullRequest: adopted,
    });
    record.supersededBy = id;
    await save();
    return {
      status: 'recovery-ready',
      id: record.id,
      successorId: id,
      launch: { action: 'launch', operation: 'context', target: issueUrl, id },
      instruction:
        'Use Task Launch with this exact successor id, then prepare and reconcile its one native creation. Old chat, checkout, commits and assessment remain evidence; the old managed task cannot resume.',
    };
  }
  if (action === 'retire') {
    if (
      state.records.some(
        (entry) =>
          !entry.handoff &&
          entry.id !== record.id &&
          (entry.threadId === caller || entry.receiptThreadId === caller),
      )
    )
      throw new Error('dispatch-operator-caller-required');
    const nativeCaller = await withNative((host) => host.operatorInput(caller));
    const client = await connect();
    const item = await client.getItem(
      intake.repository.owner.login,
      intake.repository.name,
      intake.issue.number,
    );
    if (
      !githubIdentityMatches(client.identity, intake.receiving) ||
      item.nodeId !== intake.issue.nodeId ||
      item.databaseId !== intake.issue.databaseId ||
      item.itemType !== 'issue' ||
      item.number !== intake.issue.number ||
      record.sourceThreadId !== sourceThreadId
    )
      throw new Error('dispatch-retire-target-mismatch');
    const repo = await client.getRepository(intake.repository.owner.login, intake.repository.name);
    if (
      repo.nodeId !== intake.repository.nodeId ||
      repo.databaseId !== intake.repository.databaseId
    )
      throw new Error('dispatch-repository-identity-changed');
    const threadId = record.threadId ?? record.receiptThreadId;
    if (threadId && record.request) {
      const target = await withNative((host) =>
        host.find({
          sourceThreadId: record.sourceThreadId,
          prompt: record.request!.prompt,
          createdAfter: record.createdAt,
          threadId,
          observationOnly: true,
        }),
      );
      if (!target || target.cwd !== record.worktree)
        throw new Error('dispatch-retire-target-mismatch');
    }
    const configuration = await context.readConfiguration();
    const digest = automationHash({
      record,
      manifest: manifestDigest,
      configuration,
      caller,
      nativeCaller,
    });
    await fresh();
    if (input.digest === undefined)
      return {
        status: 'retire-available',
        id: record.id,
        digest,
        issue: issueUrl,
        threadId: record.threadId ?? record.receiptThreadId,
        instruction:
          'Retire this exact managed task now, leaving its issue and branch unchanged. Reuse safe native cleanup immediately without grace; running work, preservation blockers and asynchronous reclamation remain pending.',
      };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
    const verifiedConfiguration = await context.readConfiguration();
    if (automationHash(verifiedConfiguration) !== automationHash(configuration))
      throw new Error('retirement-configuration-changed');
    const verifiedCaller = await withNative((host) => host.operatorInput(caller));
    if (
      verifiedCaller.turnId !== nativeCaller.turnId ||
      verifiedCaller.inputId !== nativeCaller.inputId
    )
      throw new Error('dispatch-native-caller-changed');
    record.reservationVersion = 1;
    record.retirement = assignmentRetirement({
      previous: record.retirement,
      reason: 'operator-requested',
      operatorRequest: {
        caller,
        turnId: nativeCaller.turnId,
        inputId: nativeCaller.inputId,
        targetId: record.id,
        at: now,
      },
      intakeId: record.intakeId ?? record.manualIssue!.id,
      now,
      ...(configuration.status === 'ready' ? { graceMinutes: configuration.graceMinutes } : {}),
    });
    delete record.feedbackReactivation;
    await save();
    return { status: 'retirement-pending', id: record.id, retirement: record.retirement };
  }
  if (action === 'reset') {
    if (
      state.records.some((entry) => entry.threadId === caller || entry.receiptThreadId === caller)
    )
      throw new Error('dispatch-operator-caller-required');
    if (record.phase !== 'complete' || !record.result || !record.request || !record.threadId)
      throw new Error('dispatch-reset-unavailable');
    const native = await withNative((client) =>
      client.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request!.prompt,
        createdAfter: record.createdAt,
        threadId: record.threadId,
      }),
    );
    if (
      !native ||
      !record.resultTurnId ||
      native.turnId !== record.resultTurnId ||
      !['idle', 'notLoaded'].includes(native.status) ||
      native.turnStatus !== 'completed'
    )
      throw new Error('dispatch-reset-chat-active');
    const digest = automationHash({ record, manifest: manifestDigest, turnId: native.turnId });
    await fresh();
    if (input.digest === undefined)
      return {
        status: 'reset-available',
        id: record.id,
        digest,
        issue: issueUrl,
        threadId: record.threadId,
        outcome: record.result.outcome,
        instruction:
          'Reset preserves this assessment and worktree. Only a new assignment event after reset permits one fresh assessment through normal intake. No implementation is authorized.',
      };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
    record.reset = { at: now, by: caller };
    await save();
    return {
      status: 'reset',
      changed: true,
      id: record.id,
      threadId: record.threadId,
      awaiting: 'new-assignment',
      reset: record.reset,
    };
  }
  if (action === 'retry-denied') {
    if (
      state.records.some((entry) =>
        [
          entry.sourceThreadId,
          entry.preparationObservation?.sourceThreadId,
          entry.threadId,
          entry.receiptThreadId,
        ].includes(caller),
      )
    )
      throw new Error('dispatch-operator-caller-required');
    if (record.denial?.operation === 'prepare') {
      if (
        !record.preparationObservation ||
        record.request ||
        record.threadId ||
        record.worktree ||
        record.clientThreadId ||
        record.receiptThreadId ||
        record.continuation?.attempt ||
        record.continuation?.publicationAttempt
      )
        throw new Error('dispatch-denial-unverified');
      await revalidate();
      const evidence = await withNative((native) =>
        native.intakeDenial(record, false, record.denial!.callId),
      );
      const retained = {
        sourceThreadId: record.denial.sourceThreadId,
        turnId: record.denial.turnId,
        callId: record.denial.callId,
        operation: record.denial.operation,
        automatic: record.denial.automatic,
        ...(record.denial.reason ? { reason: record.denial.reason } : {}),
      };
      if (!evidence || automationHash(evidence) !== automationHash(retained))
        throw new Error('dispatch-denial-unverified');
      // command readback does not distinguish human refusal from automatic review.
      if (input.approvedCallId !== evidence.callId)
        throw new Error('dispatch-denial-approval-required');
      const digest = automationHash({
        record,
        manifest: manifestDigest,
        denial: evidence,
        approvedCallId: input.approvedCallId,
      });
      await fresh();
      if (input.digest === undefined)
        return { status: 'retry-available', id: record.id, digest, denial: record.denial };
      if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
      (record.recoveredDenials ??= []).push({
        denial: record.denial,
        observation: record.preparationObservation,
        recoveredAt: now,
        approvedBy: caller,
      });
      delete record.denial;
      delete record.preparationObservation;
      delete record.result;
      delete record.stageReceipt;
      delete record.retry;
      delete record.retryAfter;
      record.phase = 'routing';
      await save();
      return { status: 'retry-ready', changed: true, id: record.id };
    }
    if (
      (!record.denial && record.sourceThreadId !== sourceThreadId) ||
      !record.request ||
      !['creating', 'blocked', 'waiting', 'retrying'].includes(record.phase) ||
      record.clientThreadId ||
      record.receiptThreadId ||
      record.threadId ||
      record.worktree ||
      record.continuation?.attempt ||
      record.continuation?.publicationAttempt
    )
      throw new Error('dispatch-denial-unverified');
    await revalidate();
    const denial = await withNative(async (native) => {
      const evidence = await native.deniedCreation(
        record.sourceThreadId,
        record.request!,
        { createdAt: record.createdAt, turnId: record.preparationTurnId },
        input.approvedCallId as string | undefined,
      );
      const found = await native.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request!.prompt,
        createdAfter: record.createdAt,
      });
      if (found) throw new Error('dispatch-denial-unverified');
      return evidence;
    });
    const digest = automationHash({
      record,
      manifest: manifestDigest,
      denial,
      approvedCallId: input.approvedCallId,
    });
    await fresh();
    if (input.digest === undefined)
      return { status: 'retry-available', id: record.id, digest, denial };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
    record.deniedCreations = [
      ...(record.deniedCreations ?? []),
      {
        request: record.request,
        createdAt: record.createdAt,
        recoveredAt: now,
        ...(record.continuation ? { continuation: record.continuation } : {}),
        ...denial,
        ...(input.approvedCallId ? { approvedBy: caller } : {}),
      },
    ];
    if (record.denial) {
      (record.recoveredDenials ??= []).push({
        denial: record.denial,
        recoveredAt: now,
        approvedBy: caller,
      });
      delete record.denial;
    }
    delete record.creationAfterItemId;
    delete record.preparationObservation;
    delete record.continuation;
    delete record.preparationTurnId;
    delete record.request;
    delete record.result;
    delete record.stageReceipt;
    delete record.retryAfter;
    record.phase = 'routing';
    await save();
    return { status: 'retry-ready', changed: true, id: record.id };
  }
}
