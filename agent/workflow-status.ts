import issueWorkflowProgress, { type IssueWorkflowState } from './issue-workflow-progress.ts';

interface State extends IssueWorkflowState {
  feedback?: {
    events: Array<{
      id?: string;
      phase: string;
      retry?: unknown;
      work?: { head?: string; result?: { outcome: string } };
      workDelivery?: IssueWorkflowState['delivery'];
    }>;
  };
}

/** feedback overlays its own work; issue status uses the coordinator's shared progress facts. */
export default function workflowStatus(record: State) {
  const progress = issueWorkflowProgress(record);
  if (progress.action === 'stopped' || record.progression?.workOwner === 'issue')
    return progress.status;
  const feedback = record.feedback?.events.findLast(
    (event) =>
      event.work && (!record.progression?.workOwner || event.id === record.progression.workOwner),
  );
  if (!feedback) return progress.status;
  const delivery = feedback.workDelivery ?? record.delivery ?? record.work?.delivery;
  if (feedback.phase === 'blocked' || feedback.work?.result?.outcome === 'blocked')
    return 'blocked';
  if (feedback.retry) return 'retrying';
  if (feedback.work?.result?.outcome === 'clarification-needed') return 'clarification-needed';
  if (!feedback.work?.result) return 'running';
  if (!delivery?.reconciled || delivery.pushedHead !== feedback.work.head) return 'delivery';
  return issueWorkflowProgress({ phase: 'complete', delivery }).status;
}
