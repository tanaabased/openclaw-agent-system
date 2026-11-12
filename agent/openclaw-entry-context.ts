import { selectOpenClawTaskContext } from './tasks/context/openclaw-task-context.ts';
import { nativeIssueContext } from './native-issue-context.ts';
import { dispatchAdmission, managedTargetUrl } from './managed-issue.ts';

import { realpath } from 'node:fs/promises';
import type { ImplementationResult } from './tasks/implementation/implementation-result.ts';
import managedImplementationRoute from './tasks/implementation/managed-implementation-route.ts';

import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { AssessmentEntryDependencies } from './tasks/assessment/assessment-entry.ts';
import assessmentOwner from './tasks/assessment/assessment-owner.ts';
import type { OpenClawTaskDependencies } from './openclaw-dispatch-context.ts';
import OpenClawDispatchStore from './openclaw-dispatch-state.ts';
import { describeIssueSession, type DispatchCaller } from './openclaw-session-create.ts';
import { nativeInputEvent, operatorInputEvent } from './openclaw-session-input.ts';
import openClawSkill from './openclaw-skill.ts';

/** native input and binding precede repository/provider access; intake activation is unnecessary. */
export default async function openClawEntryContext<T>(
  input: {
    manifest: AgentManifest;
    workspace: string;
    caller: DispatchCaller;
    action: unknown;
    operator: boolean;
    authority: DispatchAuthority;
    dependencies: OpenClawTaskDependencies;
  },
  collect: (deps: AssessmentEntryDependencies) => Promise<T>,
  routeManaged?: (
    owner: { id: string; eventId?: string },
    result?: ImplementationResult,
  ) => Promise<T>,
) {
  const nativeRead =
    !!input.action &&
    typeof input.action === 'object' &&
    'action' in input.action &&
    input.action.action === 'assessment' &&
    'operation' in input.action &&
    input.action.operation === 'context';
  const implementation =
    !!input.action &&
    typeof input.action === 'object' &&
    'action' in input.action &&
    input.action.action === 'implementation';
  const { manifest, caller, authority, dependencies: deps } = input;
  await authority.assertCurrent?.();
  const current = await selectOpenClawTaskContext(deps.taskContext, manifest, input.workspace, {
    resolvePolicy: false,
  });
  const journal = new OpenClawDispatchStore(deps.root, current.store.location.scope);
  return deps.credential.use(authority, async (request) => {
    const managed: AssessmentEntryDependencies['managed'] = async (target) => {
      const state = await journal.read();
      const admitted = await current.store.read();
      const owner = assessmentOwner(
        state.records,
        admitted?.records ?? [],
        caller.sessionKey,
        target,
      );
      if (!owner) return;
      const { record, digest } = owner;
      if (!record.worktree) throw new Error('assessment-managed-checkout-unavailable');
      if (
        !record.request ||
        !('key' in record.request) ||
        record.request.key !== caller.sessionKey ||
        record.request.agentId !== manifest.agent.id ||
        !record.sessionCreation?.verified ||
        record.sessionCreation.sessionId !== caller.sessionId
      )
        throw new Error('assessment-managed-context-invalid');
      await describeIssueSession(request, record, deps.config());
      return {
        selections: record.manualIssue?.selections,
        nativeContext: nativeRead ? nativeIssueContext(record) : undefined,
        digest,
        owner: { id: record.id },
        path: await realpath(record.worktree!),
        selection: record.assessment,
        evidence: record.context,
      };
    };
    const records = (await journal.read()).records.filter(
      (record) => record.threadId === caller.sessionKey,
    );
    if (records.length > 1) throw new Error('assessment-managed-owner-ambiguous');
    const admission =
      records[0] && dispatchAdmission(records[0], (await current.store.read())?.records ?? []);
    if (records.length && !admission) throw new Error('assessment-managed-admission-missing');
    const currentTarget = admission ? managedTargetUrl(admission) : undefined;
    const nativeContextRequest =
      !!records[0] &&
      nativeRead &&
      !!input.action &&
      typeof input.action === 'object' &&
      'operation' in input.action &&
      input.action.operation === 'context' &&
      (!('target' in input.action) ||
        input.action.target === undefined ||
        input.action.target === currentTarget);
    const readOnlyNative =
      nativeContextRequest &&
      admission &&
      Boolean(
        (
          await managed({
            repository: `${admission.repository.owner.login}/${admission.repository.name}`,
            number: admission.issue.number,
          })
        )?.nativeContext,
      );
    if (routeManaged) {
      const routed = await managedImplementationRoute({
        action: input.action,
        currentTarget,
        managed,
        route: routeManaged,
      });
      if (routed) return routed.result;
    }
    if (!input.operator && !implementation && !readOnlyNative)
      throw new Error('assessment-operator-required');
    const nativeInput = () =>
      (input.operator ? operatorInputEvent : nativeInputEvent)({
        request,
        senderIsOwner: true,
        sessionKey: caller.sessionKey,
        sessionId: caller.sessionId,
        runId: caller.runId,
        retained: [],
      });
    const turn = readOnlyNative ? undefined : await nativeInput();
    const assertCurrent = async () => {
      await authority.assertCurrent?.();
      const fresh = await deps.taskContext.manifestService.loadForAgentId(
        manifest.agent.id,
        'service',
      );
      if (
        fresh.status !== 'loaded' ||
        fresh.manifest.agent.id !== manifest.agent.id ||
        (await realpath(fresh.scope.workspaceDir)) !== current.workspace
      )
        throw new Error('assessment-binding-changed');
      if (turn && (await nativeInput()).inputEventId !== turn.inputEventId)
        throw new Error('assessment-native-input-changed');
      entry.manifest = fresh.manifest;
    };
    const entry: AssessmentEntryDependencies = {
      operator: input.operator,
      root: deps.root,
      currentTarget,
      binding: {
        runtime: 'openclaw',
        agentId: manifest.agent.id,
        workspace: current.workspace,
        namespace: deps.taskContext.namespace,
        session: caller.sessionKey,
        incarnation: caller.sessionId,
      },
      turnId: caller.runId,
      inputId: turn?.inputEventId ?? '',
      message: turn?.message,
      manifest,
      now: (deps.now ?? Date.now)(),
      assertCurrent,
      git: async (cwd, argv) => {
        if (!deps.assessmentGit) throw new Error('assessment-git-unavailable');
        await assertCurrent();
        return deps.assessmentGit({
          manifest: entry.manifest,
          workspace: current.workspace,
          caller,
          cwd,
          argv,
          signal: authority.signal ?? AbortSignal.timeout(60000),
        });
      },
      connectDelivery: async (path) => {
        await assertCurrent();
        if (!deps.delivery) throw new Error('implementation-delivery-unavailable');
        return deps.delivery({
          manifest: entry.manifest,
          workspaceDir: current.workspace,
          worktree: path,
          caller,
          signal: authority.signal ?? AbortSignal.timeout(60000),
        });
      },
      connectProvider: async () => {
        await assertCurrent();
        if (!deps.feedbackConnect) throw new Error('assessment-provider-unavailable');
        return deps.feedbackConnect(
          { manifest: entry.manifest, workspaceDir: current.workspace },
          authority.signal ?? AbortSignal.timeout(60000),
        );
      },
      resolveSkill: (id) =>
        openClawSkill(request, { agentId: manifest.agent.id, key: caller.sessionKey }, id),
      managed,
    };
    return collect(entry);
  });
}
