import taskUpdateInstructions from './task-update-instructions.ts';
import workflowNoticeInstructions from './workflow-notice-instructions.ts';

/** Shared conversation behavior; the adapters retain only native identity and operation receipts. */
export default function nativeTaskInstructions(runtime: 'codex' | 'openclaw') {
  const context =
    runtime === 'codex'
      ? 'continuationRuntime context with the complete continuationRequest (or action:context and the verified managed task id when no request is supplied)'
      : 'agent_system_dispatch action implementation-context with the current verified task id';
  const delivery =
    runtime === 'codex'
      ? 'deliveryRuntime prepare with the complete deliveryPrepareRequest, adding the authored title and body, then publish with the complete returned publishRequest'
      : 'agent_system_dispatch action delivery';
  return (
    'When initialReview is supplied, follow its display-only recovery instructions for a missing initial assessment or question. A public plan comment does not replace the private review and its routing, debug and Auto-decision cards. ' +
    `Continue this task as native conversation. Read the issue or PR and relevant discussion through currentIssue.source or evidence.source using normal GitHub tools when current requirements are needed. Follow provider pagination and recover truncated reads; unavailable context is a limitation, not evidence of absence. Follow the latest user direction, including requests to stop implementation, discuss a plan, or withhold publication. Native running, waiting and completion are not Agent System phases. The coordinator does not send keep-going messages. Previously saved assessments are explicit historical readback only; new assessments stay in native tool context without Agent System persistence or reinjection. Implementation results are optional history, never prerequisites for continued work or PR delivery. Use the configured substantive skills without repeating their bootstrap. Work permits scoped implementation from the outset. Plan requires explicit operator or verified approved-feedback implementation direction. In Auto, make a bounded proceed/wait decision in this conversation; use ${context} with decision {mode:plan|work,reasons:[...]} to retain implementation permission without saving an assessment. A Work decision or explicit implementation direction can proceed in this same turn, without a coordinator handoff. Existing permission survives ordinary clarification and revisions; it never overrides newer restrictions or native denials. Use context when permission or configured implementation guidance is needed, not as a checkpoint on every turn. Keep questions and answers in native chat; do not submit clarification results or create waiting-state records. Ask necessary questions here and publish them through the authorized update operation; wait for an answer without a scheduled nudge. ` +
    `When the requested implementation is complete and appropriately verified, use ${delivery} to create or update a PR suitable for review and merge. Do not create a pilot or partial PR unless explicitly requested. Verify the actual checkout and destination and reconcile uncertain writes through their original receipts. PR creation is not a conversation phase change. Use delivery link after initial PR creation to record the current task/PR association and perform supported native attachment as one independent linkage operation; follow its returned native attachment instructions. Operator-directed relinking or unlinking may change that association; preserve pending effects at their original destinations. Independently present the existing PR card and publish the initial PR-available update to the originating issue. Neither presentation nor announcement failure blocks conversation or invalidates the PR. Later substantial PR updates reuse the current association, may show the card again, and use Task Update for material progress without repeating the initial announcement. ` +
    taskUpdateInstructions() +
    '\n\n' +
    workflowNoticeInstructions()
  );
}
