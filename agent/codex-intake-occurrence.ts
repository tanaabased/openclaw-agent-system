import type { codexDispatchNative } from './codex-dispatch-native.ts';
import type CodexDispatchStore from './codex-dispatch-state.ts';

type State = Awaited<ReturnType<CodexDispatchStore['read']>>;
type Occurrence = Awaited<ReturnType<ReturnType<typeof codexDispatchNative>['occurrence']>>;

/** check scheduling once per native occurrence; pause never revokes an accepted run. */
export default async function acceptCodexIntakeOccurrence(
  state: State,
  occurrence: Occurrence,
  assertActive: () => Promise<unknown>,
  save: () => Promise<void>,
) {
  if (state.run?.id === occurrence.id) {
    if (state.run.automationId !== occurrence.automationId)
      throw new Error('dispatch-occurrence-mismatch');
    return;
  }
  await assertActive();
  state.run = { ...occurrence, actions: 0 };
  delete state.checked;
  await save();
}
