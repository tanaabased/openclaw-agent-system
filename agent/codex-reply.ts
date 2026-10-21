import { Value } from 'typebox/value';

import { nativeObject } from './automation-gateway.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import { dispatchHistoryPages } from './codex-dispatch-history.ts';
import connectCodexFeedback from './codex-feedback-client.ts';
import type { CodexFeedbackDependencies } from './codex-feedback.ts';
import { selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads, type CodexThreadRequest } from './codex-thread-client.ts';
import codexAssessmentSkill from './codex-assessment-skill.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';
import feedbackReply from './feedback-reply.ts';
import replyOwner from './reply-owner.ts';
import pendingPublicResponse from './pending-public-response.ts';
import type { OpenClawFeedbackProvider } from './openclaw-feedback.ts';
import { replyRequestSchema } from '../tools/dispatch/reply-schema.ts';

/** native turn and user-item identity, not user-authored markers, establish direct input custody. */
export async function codexReplyInput(request: CodexThreadRequest, threadId: string) {
  const thread = await request('thread/read', { threadId, includeTurns: false });
  if (
    !nativeObject(thread.thread) ||
    thread.thread.id !== threadId ||
    thread.thread.archived === true ||
    thread.thread.canAcceptDirectInput === false
  )
    throw new Error('reply-native-thread-unavailable');
  const turns = await request('thread/turns/list', {
    threadId,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
    limit: 1,
  });
  const turn = Array.isArray(turns.data) && turns.data[0];
  if (
    !nativeObject(turn) ||
    typeof turn.id !== 'string' ||
    (typeof turn.completedAt === 'number' && turn.completedAt > 0)
  )
    throw new Error('reply-native-turn-unavailable');
  const entries = await dispatchHistoryPages(request, 'thread/items/list', {
    threadId,
    turnId: turn.id,
    sortDirection: 'asc',
  });
  if (entries.some((entry) => entry.turnId !== turn.id || !nativeObject(entry.item)))
    throw new Error('reply-native-input-unverified');
  const items = entries.map((entry) => entry.item).filter(nativeObject);
  if (codexTurnApprovalDenied(items)) throw new Error('reply-native-approval-denied');
  const user = items.findLastIndex((item) => item.type === 'userMessage');
  const delegated = items.findLastIndex(
    (item) =>
      item.type === 'functionCallOutput' &&
      item.namespace === 'codex_app' &&
      ['create_thread', 'send_message_to_thread'].includes(String(item.name)),
  );
  if (user < 0 || typeof items[user]!.id !== 'string' || delegated > user)
    throw new Error('reply-native-user-input-required');
  return { turnId: turn.id, inputId: items[user]!.id as string };
}

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
    const turn = await codexReplyInput(connection.request, caller);
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
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
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
      manifest: current.manifest,
      readManifest,
      now: (deps.now ?? Date.now)(),
      provider,
      resolveSkill: (id) => codexAssessmentSkill(connection.request, current.workspace, id),
      assertCurrent: async () => {
        await readManifest();
        const fresh = await codexReplyInput(connection.request, caller);
        if (fresh.turnId !== turn.turnId || fresh.inputId !== turn.inputId)
          throw new Error('reply-native-input-changed');
      },
      managed: async (target) => {
        const state = await journal.read();
        const admitted = await current.store.read();
        return replyOwner(
          state.records.map((record) => {
            const item = admitted?.records.find((entry) => entry.id === record.intakeId);
            if (!item && record.threadId === caller)
              throw new Error('reply-managed-context-invalid');
            const pending = pendingPublicResponse(record);
            const summary =
              pending?.summary ??
              record.assessmentSummaries?.find(
                (entry) => entry.revision === record.assessmentRevision,
              );
            return {
              id: record.id,
              threadId: record.threadId,
              inactive: Boolean(
                record.retired ||
                record.retirement ||
                record.reset ||
                record.nativeInactive ||
                (record.threadId && !record.request),
              ),
              repository: item
                ? `${item.repository.owner.login}/${item.repository.name}`
                : undefined,
              number: item?.issue.number,
              pullRequestNumber: record.delivery?.pullRequest?.pullRequestNumber,
              events: record.feedback?.events,
              summary: record.result
                ? {
                    selection: summary?.selection,
                    receipt: summary?.receipt,
                    publicText: summary?.publicText,
                    attempt: summary?.attempt,
                  }
                : undefined,
              delivery: record.delivery,
              implementation: record.continuation?.result,
              deliveredPullRequest: record.delivery?.pullRequest,
              result: record.result,
              publisherLogin: item?.receiving.login,
            };
          }),
          caller,
          caller,
          target,
        );
      },
    });
  } finally {
    await connection.close();
  }
}
