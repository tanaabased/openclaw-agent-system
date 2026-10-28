/** the host owns delivery even when a custom skill supplies the implementation report. */
export default function implementationHandoff(
  id: string,
  outcome: 'done' | 'blocked' | 'clarification-needed' | undefined,
  runtime: 'codex' | 'openclaw',
  direct?: { publication: boolean },
  existingPullRequest = false,
) {
  if (outcome !== 'done') return { next: outcome ?? 'implementation' };
  if (direct)
    return direct.publication
      ? {
          next: 'delivery' as const,
          request: {
            action: 'implementation',
            operation: 'delivery',
            id,
            deliveryOperation: 'prepare',
          },
          instruction:
            'Continue direct implementation delivery in this same chat through dispatch implementation delivery. Supply title and body, then publish the prepared digest. Resume uncertain effects through these original receipts; never repeat implementation or create a replacement PR.',
        }
      : { next: 'complete' as const };
  return {
    next: 'delivery' as const,
    request:
      runtime === 'codex'
        ? { action: 'delivery', id, delivery: { action: 'prepare' } }
        : { action: 'delivery', id, operation: 'prepare' },
    instruction:
      `Continue PR delivery in this same turn through ${runtime === 'codex' ? 'continuationRuntime' : 'agent_system_dispatch'}. ` +
      (existingPullRequest
        ? 'Update the selected existing PR; omit title/body unless the operator requested metadata changes. Preserve its body and closing associations. '
        : runtime === 'codex'
          ? 'Add title and body inside the returned request’s nested delivery object. '
          : 'Add title and body to the returned request. ') +
      (existingPullRequest
        ? ''
        : 'Describe the verified change, validation, limitations, and closing issue reference concisely. ') +
      'Keep private context out of the public text. Publish the prepared operation with its digest and the same title/body, then follow its attachment, announcement, and card instructions. The implementation stage already authorizes routine delivery; honor user restrictions and native denials. Do not end the turn or wait for intake between these steps. If delivery is interrupted, resume the saved operation and receipts without repeating implementation or creating a replacement PR.',
  };
}
