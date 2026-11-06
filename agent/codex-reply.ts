import codexFeedbackInput from './codex-feedback-input.ts';
import codexContinuationNative from './codex-continuation-native.ts';
import authorizeCodexFeedback from './codex-feedback-authority.ts';
import type { ReplyDraft } from './reply-store.ts';
import { dispatchAdmission } from './managed-issue.ts';
import { resolve } from 'node:path';

import { Value } from 'typebox/value';

import codexReplyInput from './codex-direct-input.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import { withNative } from './codex-dispatch-context.ts';
import connectCodexFeedback from './codex-feedback-client.ts';
import type { CodexFeedbackDependencies } from './codex-feedback.ts';
import { selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import codexAssessmentSkill from './codex-assessment-skill.ts';
import feedbackReply from './feedback-reply.ts';
import replyOwner from './reply-owner.ts';
import replyOwnerContext from './reply-owner-context.ts';
import type { OpenClawFeedbackProvider } from './openclaw-feedback.ts';
import { replyRequestSchema } from '../tools/dispatch/reply-schema.ts';

export { default as codexReplyInput } from './codex-direct-input.ts';

/** standalone execution uses the portable binding and native GitHub account, never OpenClaw secrets. */
export default async function codexReply(
  pluginData: string,
  input: unknown,
  deps: CodexFeedbackDependencies,
) {
  if (!Value.Check(replyRequestSchema, input)) throw new Error('reply-request-invalid');
  const current = await selectCodexIntake(pluginData, deps, { resolvePolicy: false });
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
    let feedback: ReplyDraft['feedback'];
    const nativeInput = () =>
      codexReplyInput(connection.request, caller, async (turnId) => {
        const match = await codexFeedbackInput(
          (await journal.read()).records,
          caller,
          turnId,
          deps.continuationNative ?? codexContinuationNative(connection.request),
        );
        if (!match) return;
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
    const connect = async (): Promise<OpenClawFeedbackProvider> => {
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
      const fresh = await selectCodexIntake(pluginData, deps, { resolvePolicy: false });
      if (fresh.store.location.scope !== current.store.location.scope)
        throw new Error('reply-workspace-binding-changed');
      return fresh.manifest;
    };
    return await feedbackReply(input, {
      root: pluginData,
      binding: {
        runtime: 'codex',
        agentId: current.agentId,
        workspace: current.workspace,
        namespace: current.codexHome,
        session: caller,
        incarnation: caller,
      },
      ...turn,
      feedback,
      authorizeFeedback: async (source, target) => {
        const state = await journal.read();
        const record = state.records.find(
          (entry) => entry.id === source.ownerId && entry.threadId === caller,
        );
        const retained =
          record?.feedback?.events.find((entry) => entry.id === source.eventId) ??
          record?.feedback?.completed?.find((entry) => entry.id === source.eventId);
        const event = source;
        const fresh = await selectCodexIntake(pluginData, deps);
        const admitted =
          record && dispatchAdmission(record, (await fresh.store.read())?.records ?? []);
        if (
          !record ||
          !retained?.native ||
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
            if (!native || native.id !== caller || resolve(native.cwd) !== resolve(record.worktree))
              throw new Error('reply-managed-context-invalid');
          }
        }
        return replyOwner(
          state.records.map((record) =>
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
