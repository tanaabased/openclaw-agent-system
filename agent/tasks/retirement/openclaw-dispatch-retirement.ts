import type { DispatchAuthority } from '../../../credentials/session-dispatch.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import assignmentRetirement from './assignment-retirement.ts';
import { automationHash } from '../../automation-hash.ts';
import { openClawCleanupConfiguration } from '../../cleanup-configuration.ts';
import { dispatchAdmission, managedTargetUrl } from '../managed-issue.ts';
import reconcileOpenClawLifecycle from '../dispatch/openclaw-assignment-lifecycle.ts';
import type OpenClawDispatchContext from '../dispatch/openclaw-dispatch-context.ts';
import observeRetirementSession from './openclaw-retirement-observation.ts';
import type { DispatchCaller } from '../../openclaw-session-create.ts';
/** an operator entry records intent, then enters the same resource lifecycle as intake. */
export default async function retireOpenClawTask(options: {
  service: OpenClawDispatchContext;
  manifest: AgentManifest;
  workspace: string;
  caller: DispatchCaller;
  input: {
    id?: string;
    digest?: string;
    apply?: boolean;
  };
  operator: boolean;
  authority: DispatchAuthority;
}) {
  const { service, manifest, workspace, caller, input, authority } = options;
  if (!options.operator) throw new Error('dispatch-operator-required');
  await authority.assertCurrent?.();
  const current = await service.scope(manifest, workspace);
  const snapshot = await current.journal.read();
  const manualTarget = snapshot.records.find(
    (record) =>
      record.manualIssue &&
      (record.id === input.id || (!input.id && record.threadId === caller.sessionKey)),
  );
  const owner =
    manualTarget?.sourceThreadId ?? (await service.dependencies.coordinator(manifest, workspace));
  if (!manualTarget && caller.sessionKey === owner)
    throw new Error('dispatch-operator-caller-required');
  const selected = await current.journal.exclusive(async (state, save) => {
    const managedCaller = state.records.find((record) => record.threadId === caller.sessionKey);
    if (managedCaller && managedCaller.sessionCreation?.sessionId !== caller.sessionId)
      throw new Error('dispatch-retire-context-mismatch');
    const id = input.id ?? managedCaller?.id;
    if (!id) throw new Error('dispatch-retire-selection-required');
    const record = state.records.find((entry) => entry.id === id);
    const intake = record && dispatchAdmission(record, current.admitted.records ?? []);
    if (!record || !intake || record.reset) throw new Error('dispatch-retire-target-mismatch');
    // native identity is verified even for an already pending request; lookup failure is not success.
    await service.dependencies.credential.use(authority, (request) =>
      observeRetirementSession(request, record, manifest.agent.id, owner),
    );
    const loaded = await service.dependencies.taskContext.manifestService.loadForAgentId(
      manifest.agent.id,
      'service',
    );
    if (
      loaded.status !== 'loaded' ||
      loaded.scope.workspaceDir !== workspace ||
      loaded.manifest.agent.id !== manifest.agent.id
    )
      throw new Error('dispatch-workspace-binding-changed');
    const configuration = await openClawCleanupConfiguration(service.dependencies.config);
    const digest = automationHash({
      record,
      configuration,
      manifest: loaded.manifest,
      caller: { sessionKey: caller.sessionKey, sessionId: caller.sessionId, runId: caller.runId },
    });
    await authority.assertCurrent?.();
    if (!input.apply && !input.digest)
      return {
        status: 'retire-available',
        id,
        digest,
        issue: managedTargetUrl(intake),
        sessionKey: record.threadId,
        worktree: record.worktree,
        instruction:
          'Retire this exact task now without changing GitHub. Native cleanup may discard dirty files and local-only commits. Active work, shared resources and unfinished native cleanup remain pending; repeat this retirement invocation to reconcile.',
      };
    if (!input.apply && input.digest !== digest) throw new Error('dispatch-recovery-stale');
    const now = (service.dependencies.now ?? Date.now)();
    record.retirement = assignmentRetirement({
      previous: record.retirement,
      reason: 'operator-requested',
      intakeId: record.intakeId ?? record.manualIssue!.id,
      now,
      operatorRequest: {
        caller: caller.sessionKey,
        turnId: caller.runId,
        sessionId: caller.sessionId,
        targetId: id,
        at: now,
      },
    });
    delete record.feedbackReactivation;
    await save();
    return { status: 'retirement-pending', id, retirement: record.retirement };
  });
  if (selected.status !== 'retirement-pending') return selected;
  return (
    (await reconcileOpenClawLifecycle({
      service,
      manifest,
      workspace,
      authority,
      targetId: selected.id,
      activeSessionKey: caller.sessionKey,
    })) ?? selected
  );
}
