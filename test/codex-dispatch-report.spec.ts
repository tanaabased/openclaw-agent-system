import assert from 'node:assert/strict';
import prepareDispatchReport, { reportResponseLimit } from '../agent/codex-dispatch-report.ts';

const cards = (count: number, message = 'card') =>
  Array.from({ length: count }, (_, i) => ({
    id: i.toString(16).padStart(64, '0'),
    message,
    notify: false,
  }));
describe('agent/codex-dispatch-report', () => {
  it('should bound batches by count and utf8 response size without dropping cards', () => {
    const input = { automationId: 'intake', reports: [], now: 100 };
    assert.equal(prepareDispatchReport({ ...input, cards: cards(120) }).notices.length, 100);
    const batch = prepareDispatchReport({ ...input, cards: cards(100, '🔥'.repeat(16000)) });
    assert.equal(batch.notices.length, 1);
    assert.ok(Buffer.byteLength(batch.response) <= reportResponseLimit);
    assert.throws(
      () => prepareDispatchReport({ ...input, cards: cards(1, 'x'.repeat(128001)) }),
      /dispatch-report-capacity/,
    );
  });
  it('should freeze pending delivery while new cards arrive and distinguish repeated copy', () => {
    const input = { automationId: 'intake', cards: cards(1), reports: [], now: 100 };
    const first = prepareDispatchReport(input);
    assert.deepEqual(
      prepareDispatchReport({ ...input, cards: cards(2), reports: [first], now: 200 }),
      first,
    );
    const second = prepareDispatchReport({ ...input, cards: cards(2).slice(1), now: 200 });
    assert.notEqual(second.response, first.response);
    assert.equal(second.createdAt, 200);
  });
});
