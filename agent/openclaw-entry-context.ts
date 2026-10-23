import type { ImplementationResult } from './implementation-result.ts';
import { replyLocator } from './reply-target.ts';
import { realpath } from 'node:fs/promises';

import type { AssessmentEntryDependencies } from './assessment-entry.ts';
import assessmentOwner from './assessment-owner.ts';
import { automationHash } from './automation-hash.ts';
import type { OpenClawDispatchDependencies } from './openclaw-dispatch-context.ts';
import OpenClawDispatchStore from './openclaw-dispatch-state.ts';
import { operatorInputEvent, nativeInputEvent } from './openclaw-session-input.ts';
import { describeIssueSession, type DispatchCaller } from './openclaw-session-create.ts';
import openClawSkill from './openclaw-skill.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';

/** native input and binding precede repository/provider access; intake activation is unnecessary. */
export default async function openClawEntryContext<T>(
  input: {
    manifest: AgentManifest;
    workspace: string;
    caller: DispatchCaller;
    action: unknown;
    operator: boolean;
    authority: DispatchAuthority;
    dependencies: OpenClawDispatchDependencies;
  },
  collect: (deps: AssessmentEntryDependencies) => Promise<T>,
  routeManaged?: (
    owner: { id: string; eventId?: string },
    result?: ImplementationResult,
  ) => Promise<T>,
) {
  const implementation =
    !!input.action &&
    typeof input.action === 'object' &&
    'action' in input.action &&
    input.action.action === 'implementation';
  if (!input.operator && !implementation) throw new Error('assessment-operator-required');
  const { manifest, caller, authority, dependencies: deps } = input;
  await authority.assertCurrent?.();
  const current = await deps.intake.select(manifest, input.workspace, { resolvePolicy: false });
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
      const feedback = record.feedback?.events.find((event) => event.turn?.runId === caller.runId);
      return {
        implementationResult: feedback ? feedback.work?.result : record.work?.result,
        digest,
        owner: { id: record.id, ...(feedback ? { eventId: feedback.id } : {}) },
        path: await realpath(record.worktree!),
        selection:
          record.turnEvidence?.selection ?? record.stageReceipt?.selection ?? record.assessment!,
        evidence: record.turnEvidence?.evidence ?? record.context!,
        result: record.result,
        receipt: record.stageReceipt,
        entries: async (run) =>
          journal.exclusive(async (fresh, save) => {
            const found = assessmentOwner(
              fresh.records,
              (await current.store.read())?.records ?? [],
              caller.sessionKey,
              target,
            );
            if (!found || found.digest !== digest)
              throw new Error('assessment-managed-context-changed');
            found.record.directAssessments ??= [];
            return run(found.record.directAssessments, save);
          }),
      };
    };
    const records = (await journal.read()).records.filter(
      (record) => record.threadId === caller.sessionKey,
    );
    if (records.length > 1) throw new Error('assessment-managed-owner-ambiguous');
    const admission =
      records[0] &&
      (await current.store.read())?.records.find((record) => record.id === records[0]!.intakeId);
    if (records.length && !admission) throw new Error('assessment-managed-admission-missing');
    const currentTarget = admission
      ? `https://github.com/${admission.repository.owner.login}/${admission.repository.name}/issues/${admission.issue.number}`
      : undefined;
    if (routeManaged) {
      const action = input.action as {
        target?: string;
        id?: string;
        path?: string;
        scope?: string;
      };
      const target = action.target ?? currentTarget;
      if (target) {
        const locator = replyLocator(target);
        if (locator.itemType !== 'issue' || locator.kind)
          throw new Error('implementation-issue-url-required');
        const owner = await managed({
          repository: `${locator.owner}/${locator.name}`,
          number: locator.number,
        });
        if (owner) {
          if (
            !owner.owner ||
            (action.id && action.id !== owner.owner.id) ||
            (action.path && (await realpath(action.path)) !== owner.path)
          )
            throw new Error('implementation-managed-context-mismatch');
          if (owner.owner.eventId && action.scope)
            throw new Error('implementation-feedback-scope-owner-required');
          return await routeManaged(owner.owner, owner.implementationResult);
        }
      }
    }
    const nativeInput = () =>
      (input.operator ? operatorInputEvent : nativeInputEvent)({
        request,
        senderIsOwner: true,
        sessionKey: caller.sessionKey,
        sessionId: caller.sessionId,
        runId: caller.runId,
        retained: [],
      });
    const turn = await nativeInput();
    const assertCurrent = async () => {
      await authority.assertCurrent?.();
      const fresh = await deps.intake.dependencies.manifestService.loadForAgentId(
        manifest.agent.id,
        'service',
      );
      if (
        fresh.status !== 'loaded' ||
        fresh.manifest.agent.id !== manifest.agent.id ||
        automationHash(fresh.manifest) !== automationHash(manifest) ||
        (await realpath(fresh.scope.workspaceDir)) !== current.workspace
      )
        throw new Error('assessment-binding-changed');
      if ((await nativeInput()).inputEventId !== turn.inputEventId)
        throw new Error('assessment-native-input-changed');
    };
    return collect({
      operator: input.operator,
      root: deps.root,
      currentTarget,
      binding: {
        runtime: 'openclaw',
        agentId: manifest.agent.id,
        workspace: current.workspace,
        namespace: deps.intake.dependencies.namespace,
        session: caller.sessionKey,
        incarnation: caller.sessionId,
      },
      turnId: caller.runId,
      inputId: turn.inputEventId,
      message: turn.message,
      manifest,
      now: (deps.now ?? Date.now)(),
      assertCurrent,
      git: async (cwd, argv) => {
        if (!deps.assessmentGit) throw new Error('assessment-git-unavailable');
        await assertCurrent();
        return deps.assessmentGit({
          manifest,
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
          manifest,
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
          { manifest, workspaceDir: current.workspace },
          authority.signal ?? AbortSignal.timeout(60000),
        );
      },
      resolveSkill: (id) =>
        openClawSkill(request, { agentId: manifest.agent.id, key: caller.sessionKey }, id),
      managed,
    });
  });
}
