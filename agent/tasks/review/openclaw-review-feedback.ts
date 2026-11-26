import type { SessionStorage } from '../../storage/storage-lifecycle.ts';
import { workflowFeedbackAvailable } from '../../../channels/github/feedback-policy.ts';
import type GitHubWorkEventClient from '../../../channels/github/provider/work-event-client.ts';
import type { GitHubNotificationPolicy } from '../../../channels/github/workflow-policy.ts';
import type { OpenClawDispatchRecord } from '../dispatch/openclaw-dispatch-state.ts';
import type { OpenClawTaskDependencies } from '../dispatch/openclaw-dispatch-context.ts';
import { discoverFeedback } from '../feedback/feedback-source.ts';
import replyOwnPublications from '../feedback/reply-own-publications.ts';
import feedbackSources from '../feedback/feedback-sources.ts';

export async function scanReviewFeedback(
  record: OpenClawDispatchRecord,
  deps: OpenClawTaskDependencies,
  client: GitHubWorkEventClient,
  policy: GitHubNotificationPolicy,
  sessionStorage: SessionStorage,
) {
  const admission = record.reviewAdmission!;
  if (
    !record.threadId ||
    !record.sessionCreation?.verified ||
    !workflowFeedbackAvailable(policy, 'review-request')
  )
    return;
  const feedback = (record.feedback ??= { startedAt: record.createdAt, baseline: {}, events: [] });
  for (const target of feedbackSources(record, admission, feedback)) {
    await discoverFeedback({
      state: feedback,
      client,
      policy,
      workflow: 'review-request',
      now: Date.now(),
      owner: admission.repository.owner.login,
      name: admission.repository.name,
      ...target,
      ownCommentIds: async () => [
        ...(record.reviewPublication?.receipt ? [record.reviewPublication.receipt.nodeId] : []),
        ...(await replyOwnPublications({
          sessionStorage,
          binding: {
            runtime: 'openclaw',
            agentId: admission.agentId,
            workspace: admission.workspaceDir,
            namespace: deps.taskContext.namespace,
            session: record.threadId!,
            incarnation: record.sessionCreation!.sessionId!,
          },
          client,
          replies: client.replies,
        })),
      ],
    });
  }
  return feedback.events.find(
    (e) => ['queued', 'prepared', 'running'].includes(e.phase) && !e.turn?.cancelled,
  );
}
