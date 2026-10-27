import { managedIssueState } from './managed-issue.ts';
import cleanupConfiguration from './cleanup-configuration.ts';
import retainedIntakePolicy from './retained-intake-policy.ts';
import DiscoveryBudget from './discovery-budget.ts';
import codexRetirementNative from './codex-retirement-native.ts';
import codexRetirementCleanup, {
  type RetirementArchiveRequest,
} from './codex-retirement-cleanup.ts';
import reactivateAssignmentFeedback from './assignment-feedback-reactivation.ts';
import connectCodexFeedback from './codex-feedback-client.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import type { CodexDispatchDependencies } from './codex-dispatch-context.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import { connectCodexGitHub, selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import reconcileAssignmentLifecycle from './reconcile-assignment-lifecycle.ts';

/** lifecycle reconciliation belongs to the existing native intake occurrence, before feedback selection. */
export default async function reconcileCodexLifecycle(
  pluginData: string,
  deps: CodexDispatchDependencies,
  inventory?: unknown,
  manual?: { id: string; caller: string },
) {
  const current = await selectCodexIntake(pluginData, deps);
  const readConfiguration = deps.readInstallationConfig ?? cleanupConfiguration;
  const configuration = await readConfiguration();
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const retained = managedIssueState(await current.store.read(), (await store.read()).records);
  if (!retained?.records.length) return;
  current.policy = retainedIntakePolicy(current.manifest, retained, 'codex');
  current.policy.policy.issueAssignment!.allowed =
    current.manifest.github?.notifications?.issueAssignment?.allowed ?? [];
  const feedbackBudget = new DiscoveryBudget();
  const now = (deps.now ?? Date.now)();
  const snapshot = await store.read();
  if (
    !snapshot.records.some(
      (record) =>
        !record.supersededBy &&
        !record.retired &&
        !record.reset &&
        (manual?.id === record.id ||
          (record.lifecycleCheckedAt ?? -Infinity) + 60_000 <= now ||
          record.retirement?.archiveAttempt ||
          record.retirement?.code === 'retirement-native-inventory-required'),
    )
  )
    return;
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  const manualTarget =
    manual && snapshot.records.find((record) => record.id === manual.id && record.manualIssue);
  const activation = manualTarget
    ? { sourceThreadId: manualTarget.sourceThreadId }
    : await (deps.activation ?? inspectCodexDispatchActivation)(
        pluginData,
        { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
        false,
        true,
      );
  if (!manual && caller !== activation.sourceThreadId)
    throw new Error('dispatch-intake-caller-required');
  const connection = deps.native
    ? undefined
    : await connectCodexThreads(current.workspace, current.codexHome);
  const native = deps.native ?? codexDispatchNative(connection!.request);
  try {
    if (!caller || (manual && manual.caller !== caller))
      throw new Error('dispatch-native-caller-required');
    const occurrence = manual
      ? { id: (await native.operatorInput(caller)).turnId }
      : await native.occurrence(caller);
    const admitted = managedIssueState(await current.store.read(), snapshot.records);
    if (!admitted) throw new Error('dispatch-policy-reconciliation-required');
    return await store.exclusive(async (state, save, signal) => {
      const target = manual && state.records.find((record) => record.id === manual.id);
      if (
        manual &&
        (!target ||
          target.sourceThreadId !== activation.sourceThreadId ||
          target.retirement?.operatorRequest?.targetId !== target.id)
      )
        throw new Error('dispatch-retire-target-mismatch');
      let prepared: { id: string; request: RetirementArchiveRequest } | undefined;
      let needsInventory = false;
      const client = await (deps.connect ?? connectCodexGitHub)(current.workspace, signal);
      await reconcileAssignmentLifecycle({
        configuration,
        readConfiguration,
        records: state.records,
        admitted: admitted.records,
        policy: current.policy!,
        client,
        owner: activation.sourceThreadId,
        targetId: manual?.id,
        now,
        save,
        fresh: async () => {
          if (manual && (await native.operatorInput(caller)).turnId !== occurrence.id)
            throw new Error('dispatch-native-caller-changed');
          const selected = await selectCodexIntake(pluginData, deps);
          const live = retainedIntakePolicy(selected.manifest, admitted, 'codex');
          current.policy!.policy = live.policy;
          current.policy!.policy.issueAssignment!.allowed =
            selected.manifest.github?.notifications?.issueAssignment?.allowed ?? [];
          const verified = manualTarget
            ? { sourceThreadId: manualTarget.sourceThreadId }
            : await (deps.activation ?? inspectCodexDispatchActivation)(
                pluginData,
                { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
                false,
                true,
              );
          if (
            selected.store.location.scope !== current.store.location.scope ||
            verified.sourceThreadId !== activation.sourceThreadId
          )
            throw new Error('retirement-workflow-changed');
        },
        observe: async (record) => {
          if (!record.request) return undefined;
          const threadId = record.threadId ?? record.receiptThreadId;
          if (!threadId) throw new Error('retirement-native-creation-unresolved');
          const found = await native.find({
            sourceThreadId: record.sourceThreadId,
            prompt: record.request.prompt,
            createdAfter: record.createdAt,
            threadId,
            observationOnly: true,
          });
          if (!found) throw new Error('retirement-native-observation-unavailable');
          if (record.worktree && found.cwd !== record.worktree)
            throw new Error('retirement-worktree-identity-changed');
          if (record.retirement?.archiveAttempt && !found.archived) {
            const reader =
              deps.retirementNative ??
              (connection ? codexRetirementNative(connection.request) : undefined);
            if (
              reader &&
              (await reader.archiveOutcome(
                record.retirement.archiveAttempt.sourceThreadId ?? record.sourceThreadId,
                threadId,
                record.retirement.archiveAttempt,
                (record.retirement.archiveAttempt.sourceThreadId ?? record.sourceThreadId) ===
                  caller
                  ? occurrence.id
                  : undefined,
              )) === 'unsubmitted'
            ) {
              delete record.retirement.archiveAttempt;
              await save();
            }
          }
          return {
            archived: found.archived === true,
            idle:
              threadId !== caller &&
              Boolean(found.turnEnded && ['idle', 'notLoaded'].includes(found.status)),
            activityId: found.turnId,
          };
        },
        reactivate: async (record, intake) => {
          const pr = record.delivery?.pullRequest;
          return reactivateAssignmentFeedback({
            record,
            intake,
            policy: current.policy!,
            client,
            now,
            save,
            budget: feedbackBudget,
            comments: async () =>
              (await (deps.feedbackConnect ?? connectCodexFeedback)(current.workspace, signal))
                .comments,
            announcement: record.delivery?.announcement,
            pullRequest: pr
              ? { number: pr.pullRequestNumber, nodeId: pr.pullRequestNodeId }
              : undefined,
          });
        },
        cleanup: async (record, intake, fresh, shared, observed, issueClosed) => {
          if (!record.request && !record.worktree) return { archived: true, worktreeRemoved: true };
          if (prepared) return { archived: false, worktreeRemoved: false };
          if (!manual && state.run?.id === occurrence.id && state.run.actions >= 12)
            return {
              archived: false,
              worktreeRemoved: false,
              code: 'retirement-occurrence-budget-exhausted',
            };
          const result = await codexRetirementCleanup({
            record,
            shared,
            codexHome: current.codexHome,
            repository: intake.repository.owner.login + '/' + intake.repository.name,
            archived: observed?.archived === true,
            issueClosed,
            inventory,
            now,
            turnId: occurrence.id,
            sourceThreadId: caller,
            native:
              deps.retirementNative ??
              codexRetirementNative(async (method, params) => {
                if (!connection) throw new Error('retirement-native-observation-unavailable');
                return connection.request(method, params);
              }),
            git: deps.git,
            fresh,
            save,
          });
          if ('request' in result && result.request) {
            if (!manual) {
              if (state.run?.id !== occurrence.id)
                state.run = { ...(await native.occurrence(caller)), actions: 0 };
              state.run.actions++;
            }
            prepared = { id: record.id, request: result.request };
            await save();
          }
          if ('code' in result && result.code === 'retirement-native-inventory-required')
            needsInventory = true;
          return result;
        },
      });
      if (prepared) return { status: 'retirement-prepared', ...prepared };
      if (needsInventory)
        return {
          status: 'retirement-inventory-required',
          ...(target ? { id: target.id, retirement: target.retirement } : {}),
          instructions:
            'Call native list_threads and pass its complete parsed JSON object as threads to the same retire preview/apply request (or dispatch next from intake). Do not archive a chat without a retirement-prepared request.',
        };
      if (target)
        return {
          status: target.retired ? 'retired' : target.retirement ? 'retirement-pending' : 'active',
          id: target.id,
          retirement: target.retirement,
        };
    });
  } finally {
    await connection?.close();
  }
}
