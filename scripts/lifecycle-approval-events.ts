export function assertLifecycleChatPending(
  events: readonly { event: string; payload?: unknown }[],
  runId: string,
): void {
  for (const { event, payload } of events) {
    if (event !== 'chat' || payload === null || typeof payload !== 'object') continue;
    const row = payload as Record<string, unknown>;
    if (row.runId !== runId || !['final', 'aborted', 'error'].includes(String(row.state))) continue;

    const state = row.state === 'final' ? 'final' : row.state === 'aborted' ? 'aborted' : 'error';
    const errorMessage = typeof row.errorMessage === 'string' ? row.errorMessage : '';
    const httpStatus = errorMessage.match(/\b(?:HTTP|status)\s*[:=]?\s*([45]\d{2})\b/i)?.[1];
    throw new Error(
      `Chat ended before lifecycle approval: state=${state}${httpStatus ? ` httpStatus=${httpStatus}` : ''}. See Gateway diagnostics for the underlying failure.`,
    );
  }
}
