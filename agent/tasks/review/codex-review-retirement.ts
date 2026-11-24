import cleanupConfiguration from '../../cleanup-configuration.ts';
import reconcileAssignmentLifecycle from '../dispatch/reconcile-assignment-lifecycle.ts';
import codexRetirementCleanup from '../retirement/codex-retirement-cleanup.ts';
import type codexRetirementNative from '../retirement/codex-retirement-native.ts';
import pendingRetirement from '../retirement/pending-retirement.ts';
import retirementEffects from '../retirement/retirement-effects.ts';
import retirementLocalData from '../retirement/retirement-local-data.ts';
import { codexNativeHandoff } from '../dispatch/codex-dispatch-handoff.ts';
import type { CodexTaskSelection } from '../context/codex-task-context.ts';
import type CodexDispatchStore from '../dispatch/codex-dispatch-state.ts';
import type { DispatchState } from '../dispatch/codex-dispatch-state.ts';
import type { codexDispatchNative } from '../dispatch/codex-dispatch-native.ts';
import type { DispatchGit } from '../dispatch/codex-dispatch-project.ts';
import type { GitHubNotificationIntakeClient } from '../../../channels/github/provider/work-event-types.ts';
import reviewPolicy from './review-policy.ts';

/** review custody uses the existing closure/grace/archive/reclamation owner, not a second lifecycle. */
export default async function retireCodexReviews(input: {
  current: CodexTaskSelection;
  journal: CodexDispatchStore;
  state: DispatchState;
  client: GitHubNotificationIntakeClient;
  native: ReturnType<typeof codexDispatchNative>;
  retirementNative: ReturnType<typeof codexRetirementNative>;
  inventory: unknown;
  caller: string;
  turnId: string;
  targetId?: string;
  now: number;
  git?: DispatchGit;
  readConfiguration?: typeof cleanupConfiguration;
  fresh(): Promise<void>;
  save(): Promise<void>;
}) {
  const readConfiguration = input.readConfiguration ?? cleanupConfiguration;
  const policy = reviewPolicy(input.current.manifest, 'codex', true);
  if (!policy) return;
  let prepared:
    { status: string; nativeHandoff: ReturnType<typeof codexNativeHandoff> } | undefined;
  await reconcileAssignmentLifecycle({
    workflow: 'review-request',
    records: input.state.records,
    admitted: [],
    policy,
    client: input.client,
    targetId: input.targetId,
    now: input.now,
    configuration: await readConfiguration(),
    readConfiguration,
    fresh: input.fresh,
    save: input.save,
    observe: async (record) => {
      if (!record.request) return;
      const found = await input.native.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request.prompt,
        createdAfter: record.createdAt,
        ...(record.threadId ? { threadId: record.threadId } : {}),
        observationOnly: true,
      });
      if (!found) throw new Error('retirement-native-observation-unavailable');
      if (record.worktree && found.cwd !== record.worktree)
        throw new Error('retirement-worktree-identity-changed');
      return {
        archived: found.archived === true,
        idle:
          found.id !== input.caller &&
          found.turnEnded === true &&
          ['idle', 'notLoaded'].includes(found.status),
        activityId: found.turnId,
      };
    },
    prepare: async (record, admission) => {
      input.journal.retainRetirementEffects(input.state, retirementEffects(record, admission));
      pendingRetirement(record);
      await input.save();
    },
    cleanup: async (record, admission, fresh, shared, observed, issueClosed) => {
      if (!record.request && !record.worktree) return { archived: true, worktreeRemoved: true };
      if (prepared) return { archived: false, worktreeRemoved: false };
      const result = await codexRetirementCleanup({
        record,
        shared,
        codexHome: input.current.codexHome,
        repository: admission.repository.owner.login + '/' + admission.repository.name,
        archived: observed?.archived === true,
        issueClosed,
        inventory: input.inventory,
        now: input.now,
        turnId: input.turnId,
        sourceThreadId: input.caller,
        native: input.retirementNative,
        git: input.git,
        fresh,
        save: input.save,
      });
      if (result.request)
        prepared = {
          status: 'retirement-prepared',
          nativeHandoff: codexNativeHandoff('set_thread_archived', result.request),
        };
      return result;
    },
    dispose: async (record, admission) => {
      if (record.threadId)
        await retirementLocalData({
          sessionStorage: input.current.sessionStorage,
          root: input.current.store.location.root,
          binding: {
            runtime: 'codex',
            agentId: input.current.agentId,
            workspace: input.current.workspace,
            namespace: input.current.codexHome,
            session: record.threadId,
            incarnation: record.threadId,
          },
          intake: admission,
          retain: async (effects) => {
            input.journal.retainRetirementEffects(input.state, effects);
            await input.save();
          },
        });
      await input.journal.dispose(input.state, record);
    },
  });
  return prepared;
}
