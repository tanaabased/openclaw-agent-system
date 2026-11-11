import dispatchCreationStatus from './dispatch-creation-status.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';
import IssueDeliveryProvider from '../channels/github/publication/issue-delivery.ts';
import assignmentRetirement from './assignment-retirement.ts';
import { automationHash } from './automation-hash.ts';
import { type CleanupConfiguration } from './cleanup-configuration.ts';
import type { codexDispatchNative } from './codex-dispatch-native.ts';
import { dispatchGit, type DispatchGit } from './codex-dispatch-project.ts';
import type { DispatchRecord, DispatchState } from './codex-dispatch-state.ts';
import connectCodexGitHubAccount from './codex-github-client.ts';
import recoverIssueTask, { pendingRecoveryFeedback } from './issue-task-recovery.ts';
import { managedPullRequest, type ManagedIssue as IntakeRecord } from './managed-issue.ts';
import taskRecoveryCaller from './task-recovery-caller.ts';

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
    git?: DispatchGit;
    claim?: (operation: 'preview' | 'reserve') => Promise<unknown>;
  },
) {
  const {
    action,
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
    if (taskRecoveryCaller(record, caller)) throw new Error('dispatch-operator-caller-required');
    const operatorInput = () => withNative((host) => host.operatorInput(caller));
    return recoverIssueTask({
      ...context,
      operator: await operatorInput(),
      operatorInput,
      digest: input.digest,
      apply: input.apply === true,
      mode: record.issueMode,
      create: (record) => record,
      effects: {
        nativeDenial: Boolean(record.denial),
        pendingPush: Boolean(record.delivery?.pendingPush),
        uncertainPrCreation: Boolean(
          record.delivery?.creationAttempted && !record.delivery.pullRequest,
        ),
        uncertainAnnouncement: Boolean(
          record.announcement?.attempted && !record.announcement.receipt,
        ),
        pendingFeedback: record.feedback?.events.some(pendingRecoveryFeedback),
        assignmentClaim: Boolean((record.claimId || record.claimAccepted) && !context.claim),
      },
      observe: async () => {
        const native = await withNative((host) =>
          host.find({
            sourceThreadId: record.sourceThreadId,
            prompt: record.request!.prompt,
            createdAfter: record.createdAt,
            threadId: record.threadId,
            observationOnly: true,
          }),
        );
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
        return native;
      },
      adopt: async () => {
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
        for (const branch of [adopted.branch, adopted.base])
          await (context.git ?? dispatchGit)(intake.workspaceDir, [
            'check-ref-format',
            `refs/heads/${branch}`,
          ]);
        return adopted;
      },
    });
  }
  if (action === 'retire') {
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
      item.itemType !== (managedPullRequest(intake) ? 'pull-request' : 'issue') ||
      item.number !== intake.issue.number
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
    if (!input.apply && input.digest === undefined)
      return {
        status: 'retire-available',
        id: record.id,
        digest,
        issue: issueUrl,
        threadId: record.threadId ?? record.receiptThreadId,
        instruction:
          'Retire this exact managed task now without changing GitHub. Native cleanup may discard dirty files and local-only commits. Active work, shared resources and unverified native reclamation remain pending; repeat this retirement invocation to reconcile.',
      };
    if (!input.apply && input.digest !== digest) throw new Error('dispatch-recovery-stale');
    const verifiedConfiguration = await context.readConfiguration();
    if (automationHash(verifiedConfiguration) !== automationHash(configuration))
      throw new Error('retirement-configuration-changed');
    const verifiedCaller = await withNative((host) => host.operatorInput(caller));
    if (
      verifiedCaller.turnId !== nativeCaller.turnId ||
      verifiedCaller.inputId !== nativeCaller.inputId
    )
      throw new Error('dispatch-native-caller-changed');
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
    if (input.apply || input.digest !== undefined)
      await withNative((host) => host.operatorInput(caller));
    if (taskRecoveryCaller(record, caller)) throw new Error('dispatch-operator-caller-required');
    if (!record.request || !record.threadId) throw new Error('dispatch-reset-unavailable');
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
      !native.turnId ||
      !native.turnEnded ||
      !['idle', 'notLoaded'].includes(native.status) ||
      native.turnStatus !== 'completed'
    )
      throw new Error('dispatch-reset-chat-active');
    const digest = automationHash({ record, manifest: manifestDigest, turnId: native.turnId });
    await fresh();
    if (!input.apply && input.digest === undefined)
      return {
        status: 'reset-available',
        id: record.id,
        digest,
        issue: issueUrl,
        threadId: record.threadId,
        instruction:
          'Reset preserves this native chat and worktree. A new assignment event is required before normal intake can admit this issue again.',
      };
    if (!input.apply && input.digest !== digest) throw new Error('dispatch-recovery-stale');
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
    if (input.apply || input.renewAuthorization)
      await withNative((host) => host.operatorInput(caller));
    if (taskRecoveryCaller(record, caller)) throw new Error('dispatch-operator-caller-required');
    if (record.denial?.operation === 'prepare') {
      if (
        !record.preparationObservation ||
        record.request ||
        record.threadId ||
        record.worktree ||
        record.clientThreadId ||
        record.receiptThreadId
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
      if (!input.renewAuthorization && input.approvedCallId !== evidence.callId)
        throw new Error('dispatch-denial-approval-required');
      const digest = automationHash({
        record,
        manifest: manifestDigest,
        denial: evidence,
        approvedCallId: input.renewAuthorization ? evidence.callId : input.approvedCallId,
      });
      await fresh();
      if (!input.apply && input.digest === undefined)
        return { status: 'retry-available', id: record.id, digest, denial: record.denial };
      if (!input.apply && input.digest !== digest) throw new Error('dispatch-recovery-stale');
      record.creationRecovery = {
        ...record.creationRecovery,
        attempts: record.creationRecovery?.attempts ?? 0,
        denialRecovered: true,
      };
      delete record.denial;
      delete record.preparationObservation;

      delete record.blocker;

      delete record.retry;
      delete record.retryAfter;

      await save();
      return { status: 'retry-ready', changed: true, id: record.id };
    }
    if (
      (!record.denial && record.sourceThreadId !== sourceThreadId) ||
      !record.request ||
      !['creating', 'blocked', 'waiting', 'retrying'].includes(dispatchCreationStatus(record)) ||
      record.clientThreadId ||
      record.receiptThreadId ||
      record.threadId ||
      record.worktree
    )
      throw new Error('dispatch-denial-unverified');
    await revalidate();
    const denial = await withNative(async (native) => {
      const evidence = await native.deniedCreation(
        record.sourceThreadId,
        record.request!,
        { createdAt: record.createdAt, turnId: record.preparationTurnId },
        input.approvedCallId as string | undefined,
        input.renewAuthorization === true,
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
      approvedCallId: input.renewAuthorization ? denial.callId : input.approvedCallId,
    });
    await fresh();
    if (!input.apply && input.digest === undefined)
      return { status: 'retry-available', id: record.id, digest, denial };
    if (!input.apply && input.digest !== digest) throw new Error('dispatch-recovery-stale');
    record.creationRecovery = {
      attempts: (record.creationRecovery?.attempts ?? 0) + 1,
      denialRecovered:
        Boolean(record.denial || record.creationRecovery?.denialRecovered) || undefined,
      latest: {
        kind: 'denied',
        turnId: denial.turnId,
        callId: denial.callId,
        createdAt: record.createdAt,
        recoveredAt: now,
        ...(input.renewAuthorization || input.approvedCallId ? { approvedBy: caller } : {}),
      },
    };
    delete record.denial;
    delete record.creationAfterItemId;
    delete record.preparationObservation;

    delete record.nativeWork;
    delete record.preparationTurnId;
    delete record.request;

    delete record.blocker;

    delete record.retryAfter;

    await save();
    return { status: 'retry-ready', changed: true, id: record.id };
  }
}
