import { nativeObject } from './automation-gateway.ts';

/** Only native execution status and native approval errors establish a denial. */
export default function codexTurnApprovalDenied(items: unknown[]) {
  return items.some((item) => {
    if (!nativeObject(item)) return false;
    if (item.type === 'commandExecution' || item.type === 'fileChange')
      return item.status === 'declined';
    if (
      item.type !== 'mcpToolCall' ||
      item.status !== 'failed' ||
      item.result != null ||
      !nativeObject(item.error)
    )
      return false;
    const message = item.error.message;
    return (
      message === 'user rejected MCP tool call' ||
      (typeof message === 'string' &&
        message.startsWith('This action was rejected due to unacceptable risk.\nReason: ') &&
        message.includes(
          'Do not bypass this rejection through a workaround or indirect execution.',
        ))
    );
  });
}
