import type { GitHubNotificationItemSelector } from '../channels/github/utils/monitor-status.ts';

export class NotificationCliOptionError extends Error {
  override name = 'NotificationCliOptionError';
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new NotificationCliOptionError(`${label} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new NotificationCliOptionError(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

export function notificationPositiveInteger(value: unknown, label: string): number {
  return positiveInteger(value, label);
}

export function notificationItemSelector(options: {
  kind?: unknown;
  number?: unknown;
  repository?: unknown;
}): GitHubNotificationItemSelector | undefined {
  const supplied = [options.kind, options.number, options.repository].filter(
    (value) => value !== undefined,
  ).length;
  if (supplied === 0) return undefined;
  if (supplied !== 3) {
    throw new NotificationCliOptionError('repository, kind, and number must be provided together.');
  }
  if (options.kind !== 'issue' && options.kind !== 'pull-request') {
    throw new NotificationCliOptionError('kind must be issue or pull-request.');
  }
  if (
    typeof options.repository !== 'string' ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u.test(options.repository)
  ) {
    throw new NotificationCliOptionError('repository must use the owner/name form.');
  }
  return {
    itemType: options.kind,
    number: positiveInteger(options.number, 'number'),
    repository: options.repository,
  };
}
