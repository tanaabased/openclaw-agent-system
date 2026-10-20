/** the host owns delivery even when a custom skill supplies the implementation report. */
export default function implementationHandoff(
  id: string,
  outcome: 'done' | 'blocked' | 'clarification-needed' | undefined,
  runtime: 'codex' | 'openclaw',
) {
  if (outcome !== 'done') return { next: outcome ?? 'implementation' };
  return {
    next: 'delivery' as const,
    request:
      runtime === 'codex'
        ? { action: 'delivery', id, delivery: { action: 'prepare' } }
        : { action: 'delivery', id, operation: 'prepare' },
    instruction:
      `Continue PR delivery in this same turn through ${runtime === 'codex' ? 'continuationRuntime' : 'agent_system_dispatch'}. ` +
      (runtime === 'codex'
        ? 'Add title and body inside the returned request’s nested delivery object. '
        : 'Add title and body to the returned request. ') +
      'Describe the verified change, validation, limitations, and closing issue reference concisely. Keep private context out of the public text. Publish the prepared operation with its digest and the same title/body, then follow its attachment, announcement, and card instructions. The implementation stage already authorizes routine delivery; honor user restrictions and native denials. Do not end the turn or wait for intake between these steps. If delivery is interrupted, resume the saved operation and receipts without repeating implementation or creating a replacement PR.',
  };
}
