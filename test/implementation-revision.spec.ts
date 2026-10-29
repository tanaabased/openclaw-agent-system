import assert from 'node:assert/strict';

import implementationContext from '../agent/implementation-context.ts';
import implementationRevision from '../agent/implementation-revision.ts';

const result = { outcome: 'done' as const, summary: 'Done.', fullResult: 'Checked.' };
const original = { turnId: 'first', inputId: 'first-input' };
const current = { turnId: 'second', inputId: 'second-input' };

describe('agent/implementation-revision', () => {
  it('should admit a distinct verified input in the same turn and reject its replay', () => {
    const work = { result, resultSource: original };
    const steering = { ...original, inputId: 'steering' };
    assert.equal(implementationRevision(work, steering, true), true);
    assert.equal(implementationRevision(work, steering, false), false);
    assert.equal(
      implementationRevision({ ...work, resultHistory: [{ source: steering }] }, steering, true),
      false,
    );
    assert.equal(implementationRevision({ result }, steering, true, original.turnId), false);
    assert.equal(
      implementationRevision(
        { result, resultSource: { turnId: original.turnId, inputId: original.turnId } },
        steering,
        true,
      ),
      false,
    );
  });

  for (const runtime of ['openclaw', 'codex'] as const)
    it(`should keep ${runtime} completed recovery separate from authorized revisions`, () => {
      const work = { result, resultSource: original };
      for (const authorized of [false, true]) {
        const revision = implementationRevision(work, current, authorized);
        const context = implementationContext({
          runtime,
          id: 'issue',
          path: '/worktree',
          previousResult: result,
          revision,
        });
        assert.equal(context.deliveryOnly, !authorized);
        assert.equal(context.handoff.next, authorized ? 'implementation' : 'delivery');
        assert.equal(context.previousResult, result);
      }
    });

  it('should reject replayed inputs and missing result custody', () => {
    const work = { result, resultSource: original };
    assert.equal(implementationRevision(work, current, false), false);
    assert.equal(implementationRevision(work, { ...current, inputId: 'other' }, false), false);
    assert.equal(implementationRevision(work, original, true), false);
    assert.equal(
      implementationRevision({ ...work, resultHistory: [{ source: current }] }, current, true),
      false,
    );
    assert.equal(implementationRevision({ result }, current, true), false);
    assert.equal(implementationRevision({ result }, current, true, original.turnId), true);
    assert.equal(
      implementationRevision({ ...work, result: { ...result, outcome: 'blocked' } }, current, true),
      false,
    );
  });
});
