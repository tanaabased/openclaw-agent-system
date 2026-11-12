import taskPullRequest from '../delivery/task-pull-request.ts';
import { managedPullRequest, type ManagedIssue } from '../../managed-issue.ts';
import type { FeedbackSourceState } from './feedback-state.ts';

/** discovery scratch belongs only to the owner's currently selected sources. */
export default function feedbackSources(
  record: Parameters<typeof taskPullRequest>[0] & { id: string },
  intake: ManagedIssue,
  feedback: FeedbackSourceState,
) {
  const pr = taskPullRequest(record);
  const sources = [
    {
      number: intake.issue.number,
      nodeId: intake.issue.nodeId,
      itemType: managedPullRequest(intake) ? ('pull-request' as const) : ('issue' as const),
    },
    ...(pr && pr.pullRequestNodeId !== intake.issue.nodeId
      ? [
          {
            number: pr.pullRequestNumber,
            nodeId: pr.pullRequestNodeId,
            itemType: 'pull-request' as const,
          },
        ]
      : []),
  ];
  const selected = new Set(sources.map(({ nodeId }) => nodeId));
  for (const nodeId of Object.keys(feedback.discovery ?? {}))
    if (!selected.has(nodeId)) delete feedback.discovery![nodeId];
  for (const nodeId of Object.keys(feedback.discoveryStalls ?? {}))
    if (nodeId !== record.id && !selected.has(nodeId)) delete feedback.discoveryStalls![nodeId];
  if (feedback.lastSource && !selected.has(feedback.lastSource)) delete feedback.lastSource;
  if (
    feedback.code === 'feedback-discovery-no-progress' &&
    !Object.values(feedback.discoveryStalls ?? {}).some(({ attempts }) => attempts >= 3)
  )
    delete feedback.code;
  return sources.sort(
    (a, b) => Number(a.nodeId === feedback.lastSource) - Number(b.nodeId === feedback.lastSource),
  );
}
