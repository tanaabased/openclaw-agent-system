import { withDispatchTask } from '../dispatch/dispatch-task-scope.ts';
import { parseReplyRequest } from '../../../tools/dispatch/reply-schema.ts';
import codexAssessmentSkill from '../assessment/codex-assessment-skill.ts';
import codexContinuationNative from '../implementation/codex-continuation-native.ts';
import codexReplyInput from '../../codex-direct-input.ts';
import { withNative } from '../dispatch/codex-dispatch-context.ts';
import CodexDispatchStore from '../dispatch/codex-dispatch-state.ts';
import authorizeCodexFeedback from './codex-feedback-authority.ts';
import connectCodexFeedback from './codex-feedback-client.ts';
import codexFeedbackInput from './codex-feedback-input.ts';
import type { CodexFeedbackDependencies } from './codex-feedback.ts';
import { selectCodexTaskContext } from '../context/codex-task-context.ts';
import { connectCodexThreads } from '../../codex-thread-client.ts';
import feedbackReply from './feedback-reply.ts';
import { dispatchAdmission, managedTargetUrl } from '../managed-issue.ts';
import type { FeedbackProvider } from './feedback-provider.ts';
import replyOwnerContext from './reply-owner-context.ts';
import replyOwner from './reply-owner.ts';
import selectReplyDraft from './reply-selection.ts';
import ReplyStore, { type ReplyDraft } from './reply-store.ts';
import { feedbackTarget } from './reply-target.ts';
export { default as codexReplyInput } from '../../codex-direct-input.ts';
/** standalone execution uses the portable binding and native GitHub account, never OpenClaw secrets. */
export default function codexReply(...args: Parameters<typeof codexReplyScoped>) {
  const deps = args[2] ?? {};
  return withDispatchTask('codex', deps.threadId ?? process.env.CODEX_THREAD_ID, () =>
    codexReplyScoped(...args),
  );
}
async function codexReplyScoped(
  pluginData: string,
  request: unknown,
  deps: CodexFeedbackDependencies,
) {
  const input = parseReplyRequest(request);
  const current = await selectCodexTaskContext(pluginData, deps, { resolvePolicy: false });
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('reply-native-caller-required');
  const connection = await (deps.replyConnection ?? connectCodexThreads)(
    current.workspace,
    current.codexHome,
  );
  try {
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const binding = {
      runtime: 'codex' as const,
      agentId: current.agentId,
      workspace: current.workspace,
      namespace: current.codexHome,
      session: caller,
      incarnation: caller,
    };
    const replyStore = new ReplyStore(pluginData, binding);
    let feedback: ReplyDraft['feedback'];
    let defaultTarget: string | undefined;
    const nativeInput = () =>
      codexReplyInput(connection.request, caller, async (turnId, items) => {
        const records = (await journal.read()).records;
        let match = await codexFeedbackInput(
          records,
          caller,
          turnId,
          deps.continuationNative ?? codexContinuationNative(connection.request),
        );
        if (!match && input.target) {
          const admitted = (await current.store.read())?.records ?? [];
          const selected = records.flatMap((record) => {
            const issue = record.threadId === caller && dispatchAdmission(record, admitted);
            return issue
              ? (record.feedback?.events ?? []).filter(
                  (event) =>
                    feedbackTarget(
                      `${issue.repository.owner.login}/${issue.repository.name}`,
                      event,
                    ) === input.target,
                )
              : [];
          });
          if (selected.length > 1) throw new Error('feedback-native-input-ambiguous');
          if (selected[0]) {
            match = await codexFeedbackInput(
              records,
              caller,
              turnId,
              deps.continuationNative ?? codexContinuationNative(connection.request),
              selected[0].id,
            );
            if (!match) throw new Error('feedback-input-unverified');
          }
        }
        if (!match) {
          const owners = records.filter((record) => record.threadId === caller);
          if (owners.length > 1) throw new Error('reply-managed-owner-ambiguous');
          const record = owners[0];
          if (!record?.request || !record.worktree) return;
          const admission = dispatchAdmission(record, (await current.store.read())?.records ?? []);
          defaultTarget = admission && managedTargetUrl(admission);
          if (record.reset || record.supersededBy || record.retirement)
            throw new Error('reply-managed-context-invalid');
          const inputItem = items.findLast(
            (item) =>
              item.type === 'userMessage' ||
              (item.type === 'functionCallOutput' &&
                item.namespace === 'codex_app' &&
                ['create_thread', 'send_message_to_thread'].includes(String(item.name))),
          );
          if (typeof inputItem?.id !== 'string') return;
          const draft =
            input.operation !== 'compose' || input.material
              ? selectReplyDraft(await replyStore.read(), input, { turnId, inputId: inputItem.id })
              : undefined;
          if (input.purpose !== 'status-update' && !draft?.update) return;
          const native = await withNative(current, deps, (host) =>
            host.find({
              sourceThreadId: record.sourceThreadId,
              prompt: record.request!.prompt,
              createdAfter: record.createdAt,
              threadId: caller,
            }),
          );
          if (!native || native.id !== caller) throw new Error('reply-managed-context-invalid');
          return { inputId: inputItem.id };
        }
        const admission = dispatchAdmission(
          match.record,
          (await current.store.read())?.records ?? [],
        );
        defaultTarget =
          admission &&
          feedbackTarget(
            `${admission.repository.owner.login}/${admission.repository.name}`,
            match.event,
          );
        feedback = {
          ownerId: match.record.id,
          eventId: match.event.id,
          revision: match.event.revision,
          source: match.event.source,
          number: match.event.number,
          nodeId: match.event.nodeId,
          itemType: match.event.itemType,
        };
        return { inputId: match.attempt.id, message: match.event.source };
      });
    const turn = await nativeInput();
    const connect = async (): Promise<FeedbackProvider> => {
      const providerConnection = await (deps.feedbackConnect ?? connectCodexFeedback)(
        current.workspace,
        AbortSignal.timeout(60000),
      );
      return {
        identity: providerConnection.client.identity,
        getRepository: providerConnection.client.getRepository.bind(providerConnection.client),
        getItem: providerConnection.client.getItem.bind(providerConnection.client),
        getItemContext: providerConnection.client.getItemContext.bind(providerConnection.client),
        discoverAssigned: providerConnection.client.discoverAssigned.bind(
          providerConnection.client,
        ),
        listAssignmentEvents: providerConnection.client.listAssignmentEvents.bind(
          providerConnection.client,
        ),
        listIssueComments: providerConnection.comments.listIssueComments.bind(
          providerConnection.comments,
        ),
        getIssueComment: providerConnection.comments.getIssueComment.bind(
          providerConnection.comments,
        ),
        createIssueComment: providerConnection.comments.createIssueComment.bind(
          providerConnection.comments,
        ),
        findOwnIssueComment: providerConnection.comments.findOwnIssueComment.bind(
          providerConnection.comments,
        ),
        reviews: providerConnection.comments.reviews,
        replies: providerConnection.replies,
      };
    };
    const provider = deps.replyProvider
      ? await deps.replyProvider(current.workspace, AbortSignal.timeout(60000))
      : await connect();
    const readManifest = async () => {
      const fresh = await selectCodexTaskContext(pluginData, deps, { resolvePolicy: false });
      if (fresh.store.location.scope !== current.store.location.scope)
        throw new Error('reply-workspace-binding-changed');
      return fresh.manifest;
    };
    return await feedbackReply(input, {
      defaultTarget,
      root: pluginData,
      binding,
      ...turn,
      feedback,
      authorizeFeedback: async (source, target) => {
        const state = await journal.read();
        const record = state.records.find(
          (entry) => entry.id === source.ownerId && entry.threadId === caller,
        );
        const retained = record?.feedback?.events.find((entry) => entry.id === source.eventId);
        const event = source;
        const fresh = await selectCodexTaskContext(pluginData, deps);
        const admitted =
          record && dispatchAdmission(record, (await fresh.store.read())?.records ?? []);
        if (
          !record ||
          !retained ||
          !admitted ||
          retained.revision !== source.revision ||
          retained.sourceId !== target.source?.nodeId ||
          retained.nodeId !== target.nodeId ||
          target.nodeId !== event.nodeId
        )
          throw new Error('reply-feedback-source-changed');
        await authorizeCodexFeedback({
          conversation: true,
          current: fresh,
          record,
          event,
          intake: admitted,
          provider: { client: provider, comments: provider },
        });
      },
      manifest: current.manifest,
      readManifest,
      now: (deps.now ?? Date.now)(),
      provider,
      resolveSkill: (id) => codexAssessmentSkill(connection.request, current.workspace, id),
      assertCurrent: async () => {
        await readManifest();
        const fresh = await nativeInput();
        if (fresh.turnId !== turn.turnId || fresh.inputId !== turn.inputId)
          throw new Error('reply-native-input-changed');
      },
      managed: async (target, purpose) => {
        const state = await journal.read();
        const admitted = await current.store.read();
        if (purpose || feedback) {
          const owners = state.records.filter((record) => record.threadId === caller);
          if (owners.length > 1) throw new Error('reply-managed-owner-ambiguous');
          const record = owners[0];
          if (record) {
            if (!record.request || !record.worktree)
              throw new Error('reply-managed-context-invalid');
            const native = await withNative(current, deps, (host) =>
              host.find({
                sourceThreadId: record.sourceThreadId,
                prompt: record.request!.prompt,
                createdAfter: record.createdAt,
                threadId: record.threadId,
              }),
            );
            if (!native || native.id !== caller) throw new Error('reply-managed-context-invalid');
          }
        }
        return replyOwner(
          state.records
            .filter((record) => purpose || record.threadId === caller)
            .map((record) =>
              replyOwnerContext({
                record,
                conversation: Boolean(feedback),
                intake: dispatchAdmission(record, admitted?.records ?? []),
                caller,
                custodyInvalid: !record.request,
                delivery: record.delivery,
              }),
            ),
          caller,
          caller,
          target,
          purpose,
        );
      },
    });
  } finally {
    await connection.close();
  }
}
