import { inspectCodexDispatchActivation } from './codex-automations.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import type { CodexDispatchDependencies } from './codex-dispatch.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import { connectCodexGitHub, selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import reconcileAssignmentLifecycle from './reconcile-assignment-lifecycle.ts';

/** lifecycle reconciliation belongs to the existing native intake occurrence, before feedback selection. */
export default async function reconcileCodexLifecycle(
  pluginData: string,
  deps: CodexDispatchDependencies,
) {
  const current = await selectCodexIntake(pluginData, deps);
  if (!current.policy) return;
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const now = (deps.now ?? Date.now)();
  const snapshot = await store.read();
  if (
    !snapshot.records.some(
      (record) =>
        !record.retired &&
        !record.reset &&
        (record.lifecycleCheckedAt ?? -Infinity) + 60_000 <= now,
    )
  )
    return;
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  const activation = await (deps.activation ?? inspectCodexDispatchActivation)(
    pluginData,
    { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
    false,
    false,
  );
  if (caller !== activation.sourceThreadId) throw new Error('dispatch-intake-caller-required');
  const connection = deps.native
    ? undefined
    : await connectCodexThreads(current.workspace, current.codexHome);
  const native = deps.native ?? codexDispatchNative(connection!.request);
  try {
    await native.occurrence(caller);
    const admitted = await current.store.read();
    if (!admitted || admitted.policyDigest !== current.policy.digest)
      throw new Error('dispatch-policy-reconciliation-required');
    await store.exclusive(async (state, save, signal) => {
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
          const verified = await (deps.activation ?? inspectCodexDispatchActivation)(
            pluginData,
            { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
            false,
            false,
          );
          if (selected.digest !== current.digest || verified.sourceThreadId !== caller)
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
          return {
            archived: found.archived === true,
            idle: Boolean(found.turnEnded && ['idle', 'notLoaded'].includes(found.status)),
            activityId: found.turnId,
          };
        },
        cleanup: async (record) => {
          if (!record.request && !record.worktree) return { archived: true, worktreeRemoved: true };
          // the app-server does not expose desktop pin protection or managed worktree reclamation.
          // leave ownership with the desktop instead of deleting its checkout behind its back.
          return {
            archived: record.retirement?.reason === 'chat-archived',
            worktreeRemoved: false,
            code: 'retirement-native-cleanup-unavailable',
          };
        },
      });
    });
  } finally {
    await connection?.close();
  }
}
