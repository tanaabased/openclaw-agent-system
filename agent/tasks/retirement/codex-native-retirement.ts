import { nativeObject } from '../../automations/automation-gateway.ts';
import { automationHash } from '../../automation-hash.ts';
import codexDirectInput from '../../codex-direct-input.ts';
import type { CodexDispatchDependencies } from '../dispatch/codex-dispatch-context.ts';
import CodexDispatchStore from '../dispatch/codex-dispatch-state.ts';
import { selectCodexTaskContext } from '../context/codex-task-context.ts';
import nativeRetirement from './native-retirement.ts';
import assertNotificationResetRetirement from '../../notification-reset-retirement.ts';
import codexRetirementNative from './codex-retirement-native.ts';
import { connectCodexThreads } from '../../codex-thread-client.ts';

/** the native desktop owns archive and checkout effects; this entry prepares and observes them. */
export default async function retireCodexNative(
  pluginData: string,
  input: { native: string; digest?: string; apply?: boolean },
  deps: CodexDispatchDependencies,
) {
  const current = await selectCodexTaskContext(pluginData, deps, {
    resolvePolicy: false,
    inspectionOnly: true,
  });
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('dispatch-native-caller-required');
  const connection = await (deps.replyConnection ?? connectCodexThreads)(
    current.workspace,
    current.codexHome,
  );
  try {
    const turn = await codexDirectInput(connection.request, caller);
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const native = deps.retirementNative ?? codexRetirementNative(connection.request);
    return await nativeRetirement({
      root: pluginData,
      binding: {
        runtime: 'codex',
        agentId: current.agentId,
        workspace: current.workspace,
        namespace: current.codexHome,
        session: caller,
        incarnation: caller,
      },
      target: input.native,
      digest: input.digest,
      apply: input.apply,
      turnId: turn.turnId,
      inputId: turn.inputId,
      now: (deps.now ?? Date.now)(),
      effects:
        'Archive this exact unmanaged native Codex chat through codex_app.set_thread_archived. Normal native effects may archive descendants and reclaim its checkout/local branch; local-only work may be lost. No issue, assignment or remote branch is changed. If the desktop archive tool is unavailable, report native-retirement-capability-unavailable; do not substitute filesystem removal or a different archive owner. Existing explicit cleanup intent authorizes apply without another conversational confirmation.',
      assertCurrent: async () => {
        await deps.assertActive?.();
        const fresh = await selectCodexTaskContext(pluginData, deps, {
          resolvePolicy: false,
          inspectionOnly: true,
        });
        await assertNotificationResetRetirement(
          pluginData,
          current.store.location.scope,
          input.native,
        );
        const inputEvent = await codexDirectInput(connection.request, caller);
        if (
          fresh.workspace !== current.workspace ||
          fresh.codexHome !== current.codexHome ||
          automationHash(fresh.manifest) !== automationHash(current.manifest) ||
          inputEvent.turnId !== turn.turnId ||
          inputEvent.inputId !== turn.inputId
        )
          throw new Error('native-retirement-binding-changed');
      },
      managed: async () =>
        (await journal.read()).records.some((record) =>
          [record.threadId, record.receiptThreadId].includes(input.native),
        ),
      observe: async () => {
        const { thread } = await connection.request('thread/read', {
          threadId: input.native,
          includeTurns: false,
        });
        if (
          !nativeObject(thread) ||
          thread.id !== input.native ||
          typeof thread.cwd !== 'string' ||
          thread.ephemeral === true
        )
          throw new Error('native-retirement-target-mismatch');
        await assertNotificationResetRetirement(
          pluginData,
          current.store.location.scope,
          input.native,
          thread.cwd,
        );
        return {
          id: input.native,
          incarnation: input.native,
          cwd: thread.cwd,
          archived:
            thread.archived === true ||
            (typeof thread.path === 'string' &&
              thread.path.split(/[\\/]/u).includes('archived_sessions')),
        };
      },
      archive: async (target) => ({ threadId: target.id, archived: true, hostId: 'local' }),
      attemptOutcome: (attempt) =>
        native.archiveOutcome(
          attempt.source,
          input.native,
          attempt,
          attempt.source === caller ? turn.turnId : undefined,
        ),
    });
  } finally {
    await connection.close();
  }
}
