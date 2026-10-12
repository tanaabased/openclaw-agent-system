import assert from 'node:assert/strict';
import appendCodexNotice, {
  codexNoticeLimit,
  codexNoticeBytes,
  codexNoticeQueueFull,
} from '../agent/codex-notice-outbox.ts';

describe('agent/codex-notice-outbox', () => {
  it('should stop producers before large or escaped cards consume their byte budget', () => {
    for (const message of ['文'.repeat(32000), '\0'.repeat(32000)]) {
      let queue: Parameters<typeof appendCodexNotice>[0] = [];
      while (!codexNoticeQueueFull(queue)) {
        queue = appendCodexNotice(queue, {
          id: queue.length.toString(16).padStart(64, '0'),
          message,
          notify: false,
        });
      }
      assert.ok(queue.length < codexNoticeLimit);
      assert.ok(Buffer.byteLength(JSON.stringify(queue)) <= codexNoticeBytes);
      assert.equal(appendCodexNotice(queue, queue[0]!), queue);
      assert.throws(
        () => appendCodexNotice(queue, { id: 'f'.repeat(64), message, notify: false }),
        /codex-notice-capacity/,
      );
    }
  });
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
