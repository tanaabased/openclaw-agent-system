import { dispatchAdmission } from './managed-issue.ts';
import assignmentRetirement from './assignment-retirement.ts';
import { automationHash } from './automation-hash.ts';
import cleanupConfiguration from './cleanup-configuration.ts';
import reconcileOpenClawLifecycle from './openclaw-assignment-lifecycle.ts';
import type OpenClawDispatchContext from './openclaw-dispatch-context.ts';
import observeRetirementSession from './openclaw-retirement-observation.ts';
import type { DispatchCaller } from './openclaw-session-create.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';

/** an operator entry records intent, then enters the same resource lifecycle as intake. */
export default async function retireOpenClawTask(options: {
  service: OpenClawDispatchContext;
  manifest: AgentManifest;
  workspace: string;
  caller: DispatchCaller;
  input: { id?: string; digest?: string };
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
    if (
      managedCaller &&
      (managedCaller.id !== (input.id ?? managedCaller.id) ||
        managedCaller.sessionCreation?.sessionId !== caller.sessionId)
    )
      throw new Error('dispatch-retire-context-mismatch');
    const id = input.id ?? managedCaller?.id;
    if (!id) throw new Error('dispatch-retire-selection-required');
    const record = state.records.find((entry) => entry.id === id);
    const intake = record && dispatchAdmission(record, current.admitted.records ?? []);
    if (!record || !intake || record.sourceThreadId !== owner || record.reset)
      throw new Error('dispatch-retire-target-mismatch');
    if (record.retired)
      return record.retirement?.worktreeRemovedAt === undefined ||
        (record.retirement.archivedAt === undefined &&
          !record.retirement.sessionUnavailableObserved)
        ? {
            status: 'retirement-unverified',
            id,
            code: 'retirement-legacy-outcome-unverified',
            instruction:
              'Recover native session and checkout outcomes through the owning lifecycle; the historical retired marker alone is not completion evidence.',
          }
        : { status: 'retired', id, retirement: record.retirement };
    // native identity is verified even for an already pending request; lookup failure is not success.
    await service.dependencies.credential.use(authority, (request) =>
      observeRetirementSession(request, record, manifest.agent.id, owner),
    );
    const loaded = await service.dependencies.intake.dependencies.manifestService.loadForAgentId(
      manifest.agent.id,
      'service',
    );
    if (
      loaded.status !== 'loaded' ||
      loaded.scope.workspaceDir !== workspace ||
      loaded.manifest.agent.id !== manifest.agent.id
    )
      throw new Error('dispatch-workspace-binding-changed');
    const configuration = await (
      service.dependencies.readInstallationConfig ?? cleanupConfiguration
    )();
    const digest = automationHash({
      record,
      configuration,
      manifest: loaded.manifest,
      caller: { sessionKey: caller.sessionKey, sessionId: caller.sessionId, runId: caller.runId },
    });
    await authority.assertCurrent?.();
    if (!input.digest)
      return {
        status: 'retire-available',
        id,
        digest,
        issue: `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/issues/${intake.issue.number}`,
        sessionKey: record.threadId,
        worktree: record.worktree,
        instruction:
          'Retire this exact task now without changing its issue or branch. Cleanup uses existing preservation and native ownership checks. Running work and unfinished cleanup remain pending.',
      };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
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
