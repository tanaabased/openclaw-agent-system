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
) {
  const current = await selectCodexIntake(pluginData, deps);
  const retained = await current.store.read();
  if (!retained?.records.length) return;
  current.policy = retainedIntakePolicy(current.manifest, retained, 'codex');
  current.policy.policy.issueAssignment!.allowed =
    current.manifest.github?.notifications?.issueAssignment?.allowed ?? [];
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const feedbackBudget = new DiscoveryBudget();
  const now = (deps.now ?? Date.now)();
  const snapshot = await store.read();
  if (
    !snapshot.records.some(
      (record) =>
        !record.retired &&
        !record.reset &&
        ((record.lifecycleCheckedAt ?? -Infinity) + 60_000 <= now ||
          record.retirement?.archiveAttempt ||
          record.retirement?.code === 'retirement-native-inventory-required'),
    )
  )
    return;
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  const activation = await (deps.activation ?? inspectCodexDispatchActivation)(
    pluginData,
    { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
    false,
    true,
  );
  if (caller !== activation.sourceThreadId) throw new Error('dispatch-intake-caller-required');
  const connection = deps.native
    ? undefined
    : await connectCodexThreads(current.workspace, current.codexHome);
  const native = deps.native ?? codexDispatchNative(connection!.request);
  try {
    const occurrence = await native.occurrence(caller);
    const admitted = await current.store.read();
    if (!admitted) throw new Error('dispatch-policy-reconciliation-required');
    return await store.exclusive(async (state, save, signal) => {
      let prepared: { id: string; request: RetirementArchiveRequest } | undefined;
      let needsInventory = false;
      const client = await (deps.connect ?? connectCodexGitHub)(current.workspace, signal);
      await reconcileAssignmentLifecycle({
        records: state.records,
        admitted: admitted.records,
        policy: current.policy!,
        client,
        owner: caller,
        now,
        save,
        fresh: async () => {
          const selected = await selectCodexIntake(pluginData, deps);
          const live = retainedIntakePolicy(selected.manifest, admitted, 'codex');
          current.policy!.policy = live.policy;
          current.policy!.policy.issueAssignment!.allowed =
            selected.manifest.github?.notifications?.issueAssignment?.allowed ?? [];
          const verified = await (deps.activation ?? inspectCodexDispatchActivation)(
            pluginData,
            { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
            false,
            true,
          );
          if (
            selected.store.location.scope !== current.store.location.scope ||
            verified.sourceThreadId !== caller
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
                caller,
                threadId,
                record.retirement.archiveAttempt,
                occurrence.id,
              )) === 'unsubmitted'
            ) {
              delete record.retirement.archiveAttempt;
              await save();
            }
          }
          return {
            archived: found.archived === true,
            idle: Boolean(found.turnEnded && ['idle', 'notLoaded'].includes(found.status)),
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
        cleanup: async (record, intake, fresh, shared, observed) => {
          if (!record.request && !record.worktree) return { archived: true, worktreeRemoved: true };
          if (prepared) return { archived: false, worktreeRemoved: false };
          if (state.run?.id === occurrence.id && state.run.actions >= 12)
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
            inventory,
            now,
            turnId: occurrence.id,
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
            if (state.run?.id !== occurrence.id) state.run = { ...occurrence, actions: 0 };
            state.run.actions++;
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
          instructions:
            'Call native list_threads and pass its complete parsed JSON object as threads to dispatch next. Do not archive a chat without a retirement-prepared request.',
        };
    });
  } finally {
    await connection?.close();
  }
}
