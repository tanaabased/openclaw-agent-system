import type {
  NotificationResetRecord,
  NotificationResetResource,
} from './notification-reset-state.ts';

export interface NotificationResetContext {
  phase: NotificationResetRecord['phase'] | 'prepare';
  operation: string;
  resource?: Pick<NotificationResetResource, 'kind' | 'description'>;
}

class NotificationResetFailure extends Error {
  constructor(
    readonly context: NotificationResetContext,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'notification-reset-failed', { cause });
  }
}

/** attach execution context without changing recovery state or retrying an effect. */
export async function withNotificationResetDiagnostic<T>(
  context: NotificationResetContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotificationResetFailure) throw error;
    throw new NotificationResetFailure(context, error);
  }
}

/** expose owned codes and system causes, never arbitrary provider prose or stack traces. */
export function notificationResetDiagnostic(error: unknown) {
  const context = error instanceof NotificationResetFailure ? error.context : undefined;
  const cause = error instanceof NotificationResetFailure ? error.cause : error;
  const candidates = [
    cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined,
    cause instanceof Error ? cause.message : undefined,
  ];
  const code =
    candidates.find(
      (value): value is string =>
        typeof value === 'string' &&
        value.length <= 160 &&
        (/^(?:notification-reset|session-dispatch|automation|dispatch-session)-[a-z-]+$/u.test(
          value,
        ) ||
          [
            'EACCES',
            'EPERM',
            'ENOENT',
            'ENOSPC',
            'EIO',
            'ECONNREFUSED',
            'ECONNRESET',
            'ETIMEDOUT',
            'private-state-file-lock-busy',
            'private-state-file-lock-lost',
          ].includes(value)),
    ) ?? 'notification-reset-failed';
  return { code, ...context };
}
