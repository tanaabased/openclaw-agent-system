import { dispatchAdmission } from './managed-issue.ts';
import feedbackReply from './feedback-reply.ts';
import type { OpenClawDispatchDependencies } from './openclaw-dispatch-context.ts';
import OpenClawDispatchStore from './openclaw-dispatch-state.ts';
import { operatorInputEvent } from './openclaw-session-input.ts';
import { describeIssueSession, type DispatchCaller } from './openclaw-session-create.ts';
import replyOwner from './reply-owner.ts';
import replyOwnerContext from './reply-owner-context.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import openClawSkill from './openclaw-skill.ts';
import { realpath } from 'node:fs/promises';

/** ordinary chats need neither an intake occurrence nor an enabled notification schedule. */
export default async function openClawReply(input: {
  manifest: AgentManifest;
  workspace: string;
  caller: DispatchCaller;
  action: unknown;
  operator: boolean;
  authority: DispatchAuthority;
  dependencies: OpenClawDispatchDependencies;
}) {
  if (!input.operator) throw new Error('reply-operator-required');
  const { manifest, caller, dependencies: deps, authority } = input;
  await authority.assertCurrent?.();
  const current = await deps.intake.select(manifest, input.workspace, { resolvePolicy: false });
  const journal = new OpenClawDispatchStore(deps.root, current.store.location.scope);
  return deps.credential.use(authority, async (request) => {
    const nativeInput = async () =>
      operatorInputEvent({
        request,
        senderIsOwner: input.operator,
        sessionKey: caller.sessionKey,
        sessionId: caller.sessionId,
        runId: caller.runId,
        retained: [],
      });
    const turn = await nativeInput();
    if (!deps.feedbackConnect) throw new Error('feedback-provider-required');
    const provider = await deps.feedbackConnect(
      { manifest, workspaceDir: current.workspace },
      authority.signal ?? AbortSignal.timeout(60000),
    );
    const readManifest = async () => {
      const fresh = await deps.intake.dependencies.manifestService.loadForAgentId(
        manifest.agent.id,
        'service',
      );
      if (
        fresh.status !== 'loaded' ||
        fresh.manifest.agent.id !== manifest.agent.id ||
        (await realpath(fresh.scope.workspaceDir)) !== current.workspace
      )
        throw new Error('reply-workspace-binding-changed');
      return fresh.manifest;
    };
    const assertCurrent = async () => {
      await authority.assertCurrent?.();
      await readManifest();
      if ((await nativeInput()).inputEventId !== turn.inputEventId)
        throw new Error('reply-input-changed');
    };
    return feedbackReply(input.action, {
      root: deps.root,
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
      readManifest,
      now: (deps.now ?? Date.now)(),
      provider,
      assertCurrent,
      resolveSkill: (id) =>
        openClawSkill(request, { agentId: manifest.agent.id, key: caller.sessionKey }, id),
      managed: async (target, purpose) => {
        const state = await journal.read();
        const admitted = await current.store.read();
        if (purpose) {
          const owners = state.records.filter((record) => record.threadId === caller.sessionKey);
          if (owners.length > 1) throw new Error('reply-managed-owner-ambiguous');
          if (owners[0]) await describeIssueSession(request, owners[0], deps.config());
        }
        return replyOwner(
          state.records.map((record) =>
            replyOwnerContext({
              record,
              intake: dispatchAdmission(record, admitted?.records ?? []),
              caller: caller.sessionKey,
              incarnation: record.sessionCreation?.sessionId,
              custodyInvalid:
                !record.sessionCreation?.verified ||
                !record.sessionCreation.sessionId ||
                !record.request ||
                !('key' in record.request) ||
                record.request.key !== record.threadId ||
                record.request.agentId !== manifest.agent.id,
              delivery: record.work?.delivery,
              implementation: record.work?.result,
            }),
          ),
          caller.sessionKey,
          caller.sessionId,
          target,
          purpose,
        );
      },
    });
  });
}
