import assert from 'node:assert/strict';

import { automationHash } from '../agent/automation-hash.ts';
import {
  compactFeedback,
  retainedFeedback,
  settledFeedback,
  validFeedbackHistory,
} from '../agent/feedback-retention.ts';
import {
  feedbackSourceEventSchema,
  type FeedbackSourceEvent,
  type FeedbackSourceState,
} from '../agent/feedback-state.ts';
import {
  checkRetainedCount,
  packRetained,
  retainedDecodeBudget,
  retainedDecodedBytes,
  retainedEvidenceBytes,
  retainedHistoryLimit,
  unpackRetained,
} from '../agent/retained-history.ts';

function event(index: number): FeedbackSourceEvent {
  return {
    id: automationHash(index),
    sourceId: 'source-' + index,
    nodeId: 'issue',
    number: 3,
    itemType: 'issue',
    source: JSON.stringify({ body: 'Exact source \\ " 🚀\n'.repeat(100) }),
    revision: automationHash(['revision', index]),
    createdAt: index,
    policyDigest: 'a'.repeat(64),
    phase: 'published',
    replyRequested: true,
    publicationAttempted: true,
    receipt: { nodeId: 'reply-' + index, databaseId: index + 1 },
    nativeCompleted: true,
    result: { privateText: 'Private result ' + index, publicText: 'Reply ' + index },
  };
}

describe('agent/retained-history', () => {
  it('should preserve exact unicode and escaped evidence and reject altered packed data', () => {
    const original = {
      source: 'A\n"\\\t🚀\u0000'.repeat(5000),
      nested: { value: [false, null, 42] },
    };
    const packed = packRetained(original, 'record');
    assert.deepEqual(unpackRetained(packed), original);
    assert.equal(packed.bytes, Buffer.byteLength(JSON.stringify(original)));
    assert.ok(Buffer.byteLength(JSON.stringify(packed)) < packed.bytes);
    for (const altered of [
      { ...packed, digest: '0'.repeat(64) },
      { ...packed, bytes: packed.bytes - 1 },
      { ...packed, bytes: packed.bytes + 1 },
      { ...packed, data: packed.data + '\n' },
      { ...packed, data: 'AAAA' },
      { ...packed, version: 2 },
    ])
      assert.throws(() => unpackRetained(altered as typeof packed), /retained-evidence-invalid/);
  });

  it('should bound individual decoding, aggregate decoding and exact replay identities', () => {
    assert.throws(
      () => packRetained('x'.repeat(retainedEvidenceBytes), 'large'),
      /retained-evidence-oversize/,
    );
    assert.doesNotThrow(() => checkRetainedCount(retainedHistoryLimit, 'feedback', 'record'));
    assert.throws(
      () => checkRetainedCount(retainedHistoryLimit + 1, 'feedback', 'record'),
      (error) => {
        assert.equal(
          (error as { retentionDiagnostic: { reason: string } }).retentionDiagnostic.reason,
          'duplicate-prevention-identities',
        );
        return true;
      },
    );
    const budget = retainedDecodeBudget('dispatch', 'record');
    const evidence = packRetained('x'.repeat(retainedEvidenceBytes - 2), 'record');
    for (let i = 0; i < retainedDecodedBytes / retainedEvidenceBytes; i++) budget({ ...evidence });
    assert.throws(() => budget({ ...evidence }), /retained-history-capacity/);
  });

  it('should compact more than 400 settled events while preserving exact historical readback', () => {
    const state: FeedbackSourceState = { baseline: {}, events: [] };
    const originals = Array.from({ length: 405 }, (_, i) => event(i));
    for (const original of originals) {
      state.events.push(original);
      compactFeedback(state);
      assert.equal(state.events.length, 0);
    }
    const restarted = JSON.parse(JSON.stringify(state)) as FeedbackSourceState;
    assert.equal(restarted.history?.length, 405);
    assert.ok(validFeedbackHistory(restarted, feedbackSourceEventSchema));
    for (const original of originals)
      assert.deepEqual(retainedFeedback(restarted, original.id), original);
    const before = structuredClone(restarted);
    compactFeedback(restarted);
    assert.deepEqual(restarted, before);
    restarted.history![0]!.revision = 'f'.repeat(64);
    assert.equal(validFeedbackHistory(restarted, feedbackSourceEventSchema), false);
  });

  it('should protect uncertain native outcomes, unseen feedback and missing publication receipts', () => {
    const published = event(1);
    const variants = [
      { ...published, phase: 'queued' as const },
      { ...published, phase: 'responded' as const },
      { ...published, phase: 'blocked' as const },
      { ...published, nativeCompleted: undefined },
      { ...published, receipt: undefined },
      { ...published, receipt: undefined, replyRequested: false, nativeCompleted: undefined },
      { ...published, result: undefined },
    ];
    for (const protectedEvent of variants) {
      assert.equal(settledFeedback(protectedEvent), false);
      const state = { baseline: {}, events: [protectedEvent] };
      compactFeedback(state);
      assert.deepEqual(state.events, [protectedEvent]);
    }
    assert.equal(
      settledFeedback({ ...published, receipt: undefined, replyRequested: false }),
      true,
    );
  });
});
