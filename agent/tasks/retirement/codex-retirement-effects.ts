import type { CodexDispatchDependencies } from '../../codex-dispatch-context.ts';
import connectCodexFeedback from '../feedback/codex-feedback-client.ts';
import CodexDispatchStore from '../../codex-dispatch-state.ts';
import { selectCodexTaskContext } from '../context/codex-task-context.ts';
import reconcileRetirementEffects from './reconcile-retirement-effects.ts';
import IssueDeliveryProvider from '../../../channels/github/publication/issue-delivery.ts';
import { connectCodexThreads } from '../../codex-thread-client.ts';
import { codexDispatchNative } from '../../codex-dispatch-native.ts';

/** an explicit invocation or the existing intake owner can observe residual effects without a task. */
export default async function reconcileCodexRetirementEffects(
  pluginData: string,
  deps: CodexDispatchDependencies,
  operator = false,
) {
  const current = await selectCodexTaskContext(pluginData, deps);
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  if (!(await store.read()).retirementEffects?.length) return;
  if (operator) {
    const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
    if (!caller) throw new Error('dispatch-native-caller-required');
    const native = deps.native
      ? undefined
      : await connectCodexThreads(current.workspace, current.codexHome);
    try {
      await (deps.native ?? codexDispatchNative(native!.request)).operatorInput(caller);
    } finally {
      await native?.close();
    }
  }
  let connection: ReturnType<typeof connectCodexFeedback> | undefined;
  const connect = () =>
    (connection ??= (deps.feedbackConnect ?? connectCodexFeedback)(
      current.workspace,
      AbortSignal.timeout(20_000),
    ));
  await store.exclusive(async (state, save) => {
    await reconcileRetirementEffects({
      effects: state.retirementEffects ?? [],
      save,
      comments: async () => {
        const provider = await connect();
        return {
          identity: provider.client.identity,
          getRepository: provider.client.getRepository.bind(provider.client),
          findOwnIssueComment: provider.comments.findOwnIssueComment.bind(provider.comments),
          replies: provider.replies,
        };
      },
      delivery: async () => new IssueDeliveryProvider((await connect()).account),
    });
    if (!state.retirementEffects?.length) delete state.retirementEffects;
    await save();
  });
}
