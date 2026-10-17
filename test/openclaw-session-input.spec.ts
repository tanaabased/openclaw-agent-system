import assert from 'node:assert/strict';

import issueInputEvent, { issueInputEventId } from '../agent/openclaw-session-input.ts';

const turn = { runId: 'owned-run', message: 'exact admitted input' };
const entry = {
  role: 'user',
  content: turn.message,
  idempotencyKey: 'owned-run:user',
  __openclaw: { id: 'input-event', idempotencyKey: 'owned-run:user' },
};

describe('agent/openclaw-session-input', () => {
  it('should adopt native user input custody without requiring assistant run metadata', () => {
    assert.equal(issueInputEvent(entry, turn), 'input-event');
    assert.equal(
      issueInputEvent({ ...entry, __openclaw: { id: 'input-event' } }, turn),
      'input-event',
    );
    assert.equal(issueInputEvent({ ...entry, idempotencyKey: undefined }, turn), 'input-event');
    assert.equal(
      issueInputEvent({ ...entry, __openclaw: { ...entry.__openclaw, runId: turn.runId } }, turn),
      'input-event',
    );
  });

  it('should reject contradictory identity and incomplete input evidence', () => {
    for (const changed of [
      { ...entry, role: 'assistant' },
      { ...entry, content: 'changed input' },
      { ...entry, idempotencyKey: 'other:user' },
      { ...entry, __openclaw: { ...entry.__openclaw, idempotencyKey: 'other:user' } },
      { ...entry, __openclaw: { ...entry.__openclaw, runId: 'other' } },
      { ...entry, __openclaw: { ...entry.__openclaw, id: '' } },
      { ...entry, __openclaw: { ...entry.__openclaw, truncated: true } },
      { ...entry, idempotencyKey: undefined, __openclaw: { id: 'input-event', runId: turn.runId } },
    ]) {
      assert.equal(issueInputEvent(changed, turn), undefined);
    }
  });

  it('should bind followup identity independently of its human-authored content', () => {
    assert.equal(
      issueInputEventId({ ...entry, content: 'a human clarification' }, turn.runId),
      'input-event',
    );
    assert.equal(issueInputEventId(entry, 'unrelated-run'), undefined);
  });
});
