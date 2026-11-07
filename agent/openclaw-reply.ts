import { Value } from 'typebox/value';
import { replyRequestSchema } from '../tools/dispatch/reply-schema.ts';
import ReplyStore, { type ReplyDraft } from './reply-store.ts';
import openClawFeedbackInput from './openclaw-feedback-input.ts';
import { authorizeFeedback } from './openclaw-feedback.ts';
import assignmentIntakePolicy from './assignment-intake-policy.ts';
import { inspectIssueIdentity } from './dispatch-assignment.ts';
import { dispatchAdmission } from './managed-issue.ts';
import feedbackReply from './feedback-reply.ts';
import type { OpenClawDispatchDependencies } from './openclaw-dispatch-context.ts';
import OpenClawDispatchStore from './openclaw-dispatch-state.ts';
import { nativeInputEvent, operatorInputEvent } from './openclaw-session-input.ts';
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
  const { manifest, caller, dependencies: deps, authority } = input;
  if (!Value.Check(replyRequestSchema, input.action)) throw new Error('reply-request-invalid');
  const action = input.action;
  await authority.assertCurrent?.();
  const current = await deps.intake.select(manifest, input.workspace, { resolvePolicy: false });
  const journal = new OpenClawDispatchStore(deps.root, current.store.location.scope);
  const binding = {
    runtime: 'openclaw' as const,
    agentId: manifest.agent.id,
    workspace: current.workspace,
    namespace: deps.intake.dependencies.namespace,
    session: caller.sessionKey,
    incarnation: caller.sessionId,
  };
  const replyStore = new ReplyStore(deps.root, binding);
  return deps.credential.use(authority, async (request) => {
    let feedback: ReplyDraft['feedback'];
    const nativeInput = async () => {
      const records = (await journal.read()).records.filter(
        (record) => record.threadId === caller.sessionKey,
      );
      if (records.length > 1) throw new Error('reply-managed-owner-ambiguous');
      const record = records[0];
      const matched =
        record && (await openClawFeedbackInput(record, caller, request, deps.config()));
      if (matched) {
        feedback = {
          ownerId: record.id,
          eventId: matched.event.id,
          revision: matched.event.revision,
          source: matched.event.source,
          number: matched.event.number,
          nodeId: matched.event.nodeId,
          itemType: matched.event.itemType,
        };
        return { inputEventId: matched.inputId, message: matched.event.source };
      }
      if (!input.operator) {
        const draft =
          action.id && (await replyStore.read()).find((entry) => entry.id === action.id);
        const update = action.purpose === 'status-update' || Boolean(draft && draft.update);
        const turn = [
          record?.assessmentTurn,
          record?.decisionTurn,
          record?.work?.turn,
          record?.work?.deliveryTurn,
        ].find((entry) => entry?.runId === caller.runId);
        if (!update || !record) throw new Error('reply-operator-required');
        if (
          record.reset ||
          record.supersededBy ||
          record.retired ||
          record.retirement ||
          record.sessionCreation?.sessionId !== caller.sessionId ||
          turn?.cancelled
        )
          throw new Error('reply-managed-context-invalid');
        await describeIssueSession(request, record, deps.config(), 'feedback');
        return nativeInputEvent({
          request,
          sessionKey: caller.sessionKey,
          sessionId: caller.sessionId,
          runId: caller.runId,
          retained: [record.assessmentCaller, record.work?.caller],
        });
      }
      return operatorInputEvent({
        request,
        senderIsOwner: input.operator,
        sessionKey: caller.sessionKey,
        sessionId: caller.sessionId,
        runId: caller.runId,
        retained: [],
      });
    };
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
      binding,
      turnId: caller.runId,
      inputId: turn.inputEventId,
      message: turn.message,
      feedback,
      authorizeFeedback: async (source, target) => {
        const state = await journal.read();
        const record = state.records.find(
          (entry) => entry.id === source.ownerId && entry.threadId === caller.sessionKey,
        );
        const retained =
          record?.feedback?.events.find((entry) => entry.id === source.eventId) ??
          record?.feedback?.completed?.find((entry) => entry.id === source.eventId);
        const event = source;
        const admitted =
          record && dispatchAdmission(record, (await current.store.read())?.records ?? []);
        const fresh = await readManifest();
        const policy = assignmentIntakePolicy(fresh, 'openclaw');
        if (
          !record ||
          !retained?.native ||
          !admitted ||
          !policy ||
          retained.revision !== source.revision ||
          retained.sourceId !== target.source?.nodeId ||
          retained.nodeId !== target.nodeId ||
          target.nodeId !== event.nodeId
        )
          throw new Error('reply-feedback-source-changed');
        await authorizeFeedback({
          conversation: true,
          record,
          event,
          intake: admitted,
          policy: policy.policy,
          provider,
          assertCurrent,
          reauthorize: async () => (await inspectIssueIdentity(admitted, provider)).item,
        });
      },
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
        if (purpose || feedback) {
          const owners = state.records.filter((record) => record.threadId === caller.sessionKey);
          if (owners.length > 1) throw new Error('reply-managed-owner-ambiguous');
          if (owners[0]) await describeIssueSession(request, owners[0], deps.config(), 'feedback');
        }
        return replyOwner(
          state.records.map((record) =>
            replyOwnerContext({
              record,
              conversation: Boolean(feedback),
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
