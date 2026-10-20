export default function retirementNotice(code: string) {
  if (code === 'retirement-native-archive-unverified')
    return {
      severity: 'info' as const,
      title: 'Retirement awaiting archive confirmation',
      summary: 'Retirement is underway. Native archival has not yet been confirmed.',
      next: 'No action is needed now. Intake will check the existing archive request automatically; it will not submit a duplicate.',
    };
  if (code === 'retirement-native-reclamation-pending')
    return {
      severity: 'info' as const,
      title: 'Retirement awaiting worktree cleanup',
      summary: 'The chat is archived. Waiting for Codex to finish worktree cleanup.',
      next: 'No action is needed now. Intake will verify worktree cleanup on the next scheduled check.',
    };
  if (code === 'retirement-shared-archive-pending')
    return {
      severity: 'info' as const,
      title: 'Retirement awaiting shared chat archival',
      summary: 'This chat is archived. Other retiring chats still share its worktree.',
      next: 'No action is needed now. Intake will finish worktree cleanup after the other eligible chats are archived.',
    };
  if (
    code === 'retirement-session-identity-unresolved' ||
    code === 'retirement-session-identity-changed'
  )
    return {
      severity: 'warning' as const,
      title: 'Retirement session identity needs attention',
      summary: 'The retained session receipt could not be matched to the native chat.',
      next: 'Compare the retained creation receipt with the native session identity. Preserve ambiguous or replaced chats; do not create a replacement just to retire it.',
    };
  if (code.startsWith('dispatch-session-response-invalid'))
    return {
      severity: 'warning' as const,
      title: 'Retirement observation unavailable',
      summary: 'A native session response did not contain the required structure.',
      next: 'Inspect the method, field, and value type named in the diagnostic. Intake will retry observation; no archive or removal is authorized by a malformed response.',
    };
  if (code.startsWith('retirement-'))
    return {
      severity: 'warning' as const,
      title: 'Retirement cleanup needs attention',
      summary: 'Automatic retirement could not finish. The retained resources remain protected.',
      next:
        code === 'retirement-worktree-shared'
          ? 'Inspect the other native chats using this worktree. Preserve independent or running work; intake will retry after the ownership blocker clears.'
          : code === 'retirement-worktree-dirty' || code === 'retirement-worktree-unpreserved'
            ? 'Preserve the checkout changes and commits before cleanup. Intake will retry after the preservation check succeeds.'
            : 'Inspect the retained retirement diagnostic and native resource state. Reconcile uncertain archive results; do not force removal or repeat a denied operation.',
    };
}
