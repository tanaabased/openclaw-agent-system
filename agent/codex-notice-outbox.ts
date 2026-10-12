import { Type, type Static } from 'typebox';

export const codexNoticeLimit = 100;
export const codexNoticeBytes = 1024 * 1024;
const messageLimit = 32000;
// reserve one largest schema-valid card, including json escaping and envelope fields.
const nextNoticeBytes = messageLimit * 6 + 256;

export function codexNoticeQueueFull(notices: CodexNotice[] = []) {
  return (
    notices.length >= codexNoticeLimit ||
    Buffer.byteLength(JSON.stringify(notices)) + nextNoticeBytes > codexNoticeBytes
  );
}

export const codexNoticeSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    message: Type.String({ minLength: 1, maxLength: messageLimit }),
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
