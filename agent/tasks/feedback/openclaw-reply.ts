import { selectOpenClawTaskContext } from '../context/openclaw-task-context.ts';
import { realpath } from 'node:fs/promises';
import type { DispatchAuthority } from '../../../credentials/session-dispatch.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import { parseReplyRequest } from '../../../tools/dispatch/reply-schema.ts';
import assignmentIntakePolicy from '../../assignment-intake-policy.ts';
import { inspectIssueIdentity } from '../dispatch/dispatch-assignment.ts';
import feedbackReply from './feedback-reply.ts';
import { dispatchAdmission, managedTargetUrl } from '../managed-issue.ts';
import type { OpenClawTaskDependencies } from '../dispatch/openclaw-dispatch-context.ts';
import OpenClawDispatchStore from '../dispatch/openclaw-dispatch-state.ts';
import openClawFeedbackInput from './openclaw-feedback-input.ts';
import { authorizeFeedback } from './openclaw-feedback.ts';
import openClawNativeTurns from '../../openclaw-native-turns.ts';
import { describeIssueSession, type DispatchCaller } from '../../openclaw-session-create.ts';
import { nativeInputEvent, operatorInputEvent } from '../../openclaw-session-input.ts';
import openClawSkill from '../../openclaw-skill.ts';
import replyOwnerContext from './reply-owner-context.ts';
import replyOwner from './reply-owner.ts';
import selectReplyDraft from './reply-selection.ts';
import ReplyStore, { type ReplyDraft } from './reply-store.ts';
import { feedbackTarget } from './reply-target.ts';
/** ordinary chats need neither an intake occurrence nor an enabled notification schedule. */
export default async function openClawReply(input: {
  manifest: AgentManifest;
  workspace: string;
  caller: DispatchCaller;
  action: unknown;
  operator: boolean;
  authority: DispatchAuthority;
  dependencies: OpenClawTaskDependencies;
}) {
  const { manifest, caller, dependencies: deps, authority } = input;
  const action = parseReplyRequest(input.action);
  await authority.assertCurrent?.();
  const current = await selectOpenClawTaskContext(deps.taskContext, manifest, input.workspace, {
    resolvePolicy: false,
  });
  const journal = new OpenClawDispatchStore(deps.root, current.store.location.scope);
  const binding = {
    runtime: 'openclaw' as const,
    agentId: manifest.agent.id,
    workspace: current.workspace,
    namespace: deps.taskContext.namespace,
    session: caller.sessionKey,
    incarnation: caller.sessionId,
  };
  const replyStore = new ReplyStore(deps.root, binding);
  return deps.credential.use(authority, async (request) => {
    let feedback: ReplyDraft['feedback'];
    let defaultTarget: string | undefined;
    const nativeInput = async () => {
      const records = (await journal.read()).records.filter(
        (record) => record.threadId === caller.sessionKey,
      );
      if (records.length > 1) throw new Error('reply-managed-owner-ambiguous');
      const record = records[0];
      const readNativeInput = () =>
        nativeInputEvent({
          request,
          sessionKey: caller.sessionKey,
          sessionId: caller.sessionId,
          runId: caller.runId,
          retained: [record?.assessmentCaller, record?.work?.caller],
        });
      let native: Awaited<ReturnType<typeof readNativeInput>> | undefined;
      let matched = record && (await openClawFeedbackInput(record, caller, request, deps.config()));
      if (!matched && action.target && (action.operation !== 'compose' || action.material)) {
        native = await readNativeInput();
        const draft = selectReplyDraft(await replyStore.read(), action, {
          turnId: caller.runId,
          inputId: native.inputEventId,
        });
        if (record && draft?.feedback)
          matched = await openClawFeedbackInput(
            record,
            caller,
            request,
            deps.config(),
            draft.feedback.eventId,
          );
      }
      const admission =
        record && dispatchAdmission(record, (await current.store.read())?.records ?? []);
      defaultTarget =
        admission &&
        (matched
          ? feedbackTarget(
              `${admission.repository.owner.login}/${admission.repository.name}`,
              matched.event,
            )
          : managedTargetUrl(admission));
      if (record && matched) {
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
        const turn = [...(record ? openClawNativeTurns(record).map(({ turn }) => turn) : [])].find(
          (entry) => entry?.runId === caller.runId,
        );
        if (!record) throw new Error('reply-operator-required');
        if (
          record.reset ||
          record.supersededBy ||
          record.retirement ||
          record.sessionCreation?.sessionId !== caller.sessionId ||
          turn?.cancelled
        )
          throw new Error('reply-managed-context-invalid');
        await describeIssueSession(request, record, deps.config(), 'conversation');
        native ??= await readNativeInput();
        const draft =
          action.operation !== 'compose' || action.material
            ? selectReplyDraft(await replyStore.read(), action, {
                turnId: caller.runId,
                inputId: native.inputEventId,
              })
            : undefined;
        if (action.purpose !== 'status-update' && !draft?.update)
          throw new Error('reply-operator-required');
        return native;
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
      const fresh = await deps.taskContext.manifestService.loadForAgentId(
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
      defaultTarget,
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
        const retained = record?.feedback?.events.find((entry) => entry.id === source.eventId);
        const event = source;
        const admitted =
          record && dispatchAdmission(record, (await current.store.read())?.records ?? []);
        const fresh = await readManifest();
        const policy = assignmentIntakePolicy(fresh, 'openclaw');
        if (
          !record ||
          !retained ||
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
          if (owners[0])
            await describeIssueSession(request, owners[0], deps.config(), 'conversation');
        }
        return replyOwner(
          state.records
            .filter((record) => purpose || record.threadId === caller.sessionKey)
            .map((record) =>
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
                delivery: record.delivery,
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
