import assert from 'node:assert/strict';
import appendCodexNotice, {
  codexNoticeLimit,
  codexNoticeQueueFull,
} from '../agent/codex-notice-outbox.ts';

describe('agent/codex-notice-outbox', () => {
  it('should preserve a full queue and permit duplicate retries without exceeding its limit', () => {
    const notice = (i: number) => ({
      id: i.toString(16).padStart(64, '0'),
      message: 'card',
      notify: false,
    });
    const existing = Array.from({ length: codexNoticeLimit - 1 }, (_, i) => notice(i));
    assert.equal(codexNoticeQueueFull(existing), false);
    const full = appendCodexNotice(existing, notice(codexNoticeLimit));
    assert.equal(codexNoticeQueueFull(full), true);
    assert.equal(appendCodexNotice(full, full[0]!), full);
    assert.throws(
      () => appendCodexNotice(full, notice(codexNoticeLimit + 1)),
      /codex-notice-capacity/,
    );
    assert.equal(full.length, codexNoticeLimit);
  });
});
