import { Type, type Static } from 'typebox';

export const codexNoticeLimit = 100;

export function codexNoticeQueueFull(notices: CodexNotice[] = []) {
  return notices.length >= codexNoticeLimit;
}

export const codexNoticeSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    message: Type.String({ minLength: 1, maxLength: 32000 }),
    notify: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type CodexNotice = Static<typeof codexNoticeSchema>;

/** retain an undelivered card once; reading or rendering is not delivery. */
export default function appendCodexNotice(existing: CodexNotice[] = [], notice: CodexNotice) {
  if (existing.some((entry) => entry.id === notice.id)) return existing;
  if (codexNoticeQueueFull(existing)) throw new Error('codex-notice-capacity');
  return [...existing, notice];
}
