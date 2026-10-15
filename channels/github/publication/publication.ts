import { redactSensitiveText } from 'openclaw/plugin-sdk/logging-core';

import * as contract from './publication-contract.ts';

export * from './publication-contract.ts';

/** preserve the openclaw redaction boundary around the portable publication contract. */
export function githubNotificationPublicationText(
  intent: Parameters<typeof contract.githubNotificationPublicationText>[0],
  payloads: Parameters<typeof contract.githubNotificationPublicationText>[1],
) {
  return contract.githubNotificationPublicationText(intent, payloads, redactSensitiveText);
}

export function githubNotificationAttributedReplyText(value: string, login: string) {
  return contract.githubNotificationAttributedReplyText(value, login, redactSensitiveText);
}
