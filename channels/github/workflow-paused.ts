/** legacy in-memory declarations and persisted snapshots use the inverse alias. */
export default function workflowPaused(workflow: { paused?: boolean; enabled?: boolean }) {
  return workflow.paused ?? workflow.enabled === false;
}
