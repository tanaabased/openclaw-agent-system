import type { AgentManifest } from '../manifest/types.ts';
import type { OpenClawDispatchDependencies } from './openclaw-dispatch-context.ts';
import OpenClawDispatchStore from './openclaw-dispatch-state.ts';
import reconcileRetirementEffects from './reconcile-retirement-effects.ts';

/** recovery remains available to explicit invocations even without an intake schedule or task. */
export default async function reconcileOpenClawRetirementEffects(input: {
  dependencies: OpenClawDispatchDependencies;
  manifest: AgentManifest;
  workspace: string;
  signal?: AbortSignal;
}) {
  const { dependencies: deps, manifest, workspace } = input;
  const current = await deps.intake.select(manifest, workspace);
  const store = new OpenClawDispatchStore(deps.root, current.store.location.scope);
  if (!(await store.read()).retirementEffects?.length) return;
  const selection = { manifest, workspaceDir: workspace };
  const signal = input.signal ?? AbortSignal.timeout(20_000);
  let connection: ReturnType<typeof deps.connect> | undefined;
  const connect = () => (connection ??= deps.connect(selection, signal));
  await store.exclusive(async (state, save) => {
    await reconcileRetirementEffects({
      effects: state.retirementEffects ?? [],
      save,
      comments: async () => {
        if (!deps.feedbackConnect) throw new Error('feedback-provider-unavailable');
        return deps.feedbackConnect(selection, signal, await connect());
      },
      delivery: async () => {
        if (!deps.retirementDelivery) throw new Error('retirement-delivery-provider-unavailable');
        return deps.retirementDelivery(selection, signal, await connect());
      },
    });
    if (!state.retirementEffects?.length) delete state.retirementEffects;
    await save();
  });
}
