import {
  resolveMessageReceiptPrimaryId,
  type DurableInboundReplyDeliveryResult,
} from 'openclaw/plugin-sdk/channel-outbound';

export class GitHubNotificationDurableDeliveryError extends Error {
  override name = 'GitHubNotificationDurableDeliveryError';

  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super('The GitHub notification publication was not confirmed.', options);
  }
}

/** Resolve one provider comment receipt from OpenClaw's durable outbound result. */
export function githubNotificationDurableDeliveryReceipt(
  result: DurableInboundReplyDeliveryResult,
): { databaseId: number; nodeId: string } {
  if (result.status !== 'handled_visible') {
    throw new GitHubNotificationDurableDeliveryError(
      result.status === 'failed'
        ? 'github-notification-publication-failed'
        : 'github-notification-publication-not-confirmed',
      result.status === 'failed' ? { cause: result.error } : undefined,
    );
  }
  const receipt = result.delivery.receipt;
  const databaseIdText =
    (receipt ? resolveMessageReceiptPrimaryId(receipt) : undefined) ??
    result.delivery.messageIds?.[0];
  const nodeId = receipt?.parts.find((part) => part.platformMessageId === databaseIdText)?.raw?.meta
    ?.nodeId;
  const databaseId = Number(databaseIdText);
  if (!Number.isSafeInteger(databaseId) || databaseId < 1 || typeof nodeId !== 'string') {
    throw new GitHubNotificationDurableDeliveryError(
      'github-notification-publication-receipt-invalid',
    );
  }
  return { databaseId, nodeId };
}
