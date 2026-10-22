import { Value } from 'typebox/value';

import codexReplyInput from './codex-direct-input.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import connectCodexFeedback from './codex-feedback-client.ts';
import type { CodexFeedbackDependencies } from './codex-feedback.ts';
import { selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import codexAssessmentSkill from './codex-assessment-skill.ts';
import feedbackReply from './feedback-reply.ts';
import replyOwner from './reply-owner.ts';
import pendingPublicResponse from './pending-public-response.ts';
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
