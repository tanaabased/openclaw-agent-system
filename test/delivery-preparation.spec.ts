import assert from 'node:assert/strict';

import {
  assertDeliveryBinding,
  deliveryContentUpdate,
  selectDeliveryDestination,
} from '../agent/tasks/delivery/delivery-preparation.ts';
import type { IssueDeliveryState } from '../agent/tasks/delivery/issue-delivery-state.ts';

function delivery(): IssueDeliveryState {
  return {
    id: 'a'.repeat(64),
    binding: {
      repositoryId: 'repo',
      issueId: 'issue',
      threadId: 'thread',
      sessionId: 'session',
      worktree: '/checkout',
      branch: 'task',
      base: 'main',
      head: 'b'.repeat(40),
      authorId: 'author',
    },
    title: 'original title',
    body: 'original body',
    creationAttempted: false,
    reconciled: false,
  };
}

describe('task delivery preparation', () => {
  it('should use the repository default or explicit base before publication', () => {
    assert.deepEqual(selectDeliveryDestination({ repositoryDefault: 'trunk' }), {
      base: 'trunk',
      retainedBase: undefined,
    });
    assert.deepEqual(
      selectDeliveryDestination({ repositoryDefault: 'trunk', requestedBase: 'release' }),
      { base: 'release', retainedBase: undefined },
    );
  });

  it('should allow changing a preview destination before any external effect', () => {
    const previous = delivery();
    assert.deepEqual(selectDeliveryDestination({ previous, repositoryDefault: 'trunk' }), {
      base: 'trunk',
      retainedBase: undefined,
    });
    assert.doesNotThrow(() =>
      assertDeliveryBinding(previous, { ...previous.binding, branch: 'revised', base: 'trunk' }),
    );
  });

  const effects: Array<[string, Partial<IssueDeliveryState>]> = [
    ['uncertain push', { pendingPush: { previousHead: '', head: 'b'.repeat(40) } }],
    ['confirmed push', { pushedHead: 'b'.repeat(40) }],
    ['attempted creation', { creationAttempted: true }],
    ['existing pr', { pullRequest: { pullRequestNodeId: 'pr', pullRequestNumber: 12 } }],
  ];
  for (const [name, effect] of effects) {
    it(`should retain the original destination after ${name}`, () => {
      const previous = { ...delivery(), ...effect };
      assert.deepEqual(selectDeliveryDestination({ previous, repositoryDefault: 'trunk' }), {
        base: 'main',
        retainedBase: 'main',
      });
      assert.throws(
        () =>
          selectDeliveryDestination({
            previous,
            repositoryDefault: 'trunk',
            requestedBase: 'release',
          }),
        { message: 'delivery-base-changed' },
      );
      assert.throws(
        () => assertDeliveryBinding(previous, { ...previous.binding, branch: 'other' }),
        { message: 'delivery-branch-changed' },
      );
      assert.throws(() => assertDeliveryBinding(previous, { ...previous.binding, base: 'other' }), {
        message: 'delivery-base-changed',
      });
      assert.doesNotThrow(() =>
        assertDeliveryBinding(previous, { ...previous.binding, head: 'c'.repeat(40) }),
      );
    });
  }

  it('should honor the verified selected pr base and refuse an authored replacement', () => {
    const input = {
      previous: delivery(),
      repositoryDefault: 'trunk',
      selectedBase: 'release',
    };
    assert.deepEqual(selectDeliveryDestination(input), {
      base: 'release',
      retainedBase: 'release',
    });
    assert.throws(() => selectDeliveryDestination({ ...input, requestedBase: 'trunk' }), {
      message: 'delivery-base-changed',
    });
  });

  const identities = [
    ['repositoryId', 'repository'],
    ['issueId', 'issue'],
    ['sessionId', 'session'],
    ['threadId', 'thread'],
    ['worktree', 'worktree'],
    ['authorId', 'account'],
  ] as const;
  for (const [field, reason] of identities) {
    it(`should reject a changed ${reason} even before publication`, () => {
      const previous = delivery();
      assert.throws(
        () => assertDeliveryBinding(previous, { ...previous.binding, [field]: 'other' }),
        { message: `delivery-${reason}-changed` },
      );
    });
  }

  it('should compare native incarnations only when supplied by the native adapter', () => {
    const previous = delivery();
    const current = { ...previous.binding };
    delete current.sessionId;
    assert.doesNotThrow(() => assertDeliveryBinding(previous, current));
    assert.throws(() => assertDeliveryBinding(previous, { ...current, sessionId: 'new-session' }), {
      message: 'delivery-session-changed',
    });
  });

  it('should leave new publication content to the creation request', () => {
    assert.deepEqual(deliveryContentUpdate(undefined, { title: 'new', body: 'body' }), {});
    assert.deepEqual(deliveryContentUpdate(delivery(), { title: 'new', body: 'body' }), {});
  });

  it('should preserve an uncertain content update while adding only changed fields', () => {
    const previous = {
      ...delivery(),
      pullRequest: { pullRequestNodeId: 'pr', pullRequestNumber: 12 },
      contentUpdate: { body: 'pending body' },
      contentUpdateAttempted: true,
    };
    const original = structuredClone(previous);
    assert.deepEqual(deliveryContentUpdate(previous, { title: 'new title', body: previous.body }), {
      title: 'new title',
      body: 'pending body',
    });
    assert.deepEqual(deliveryContentUpdate(previous, { title: previous.title, body: '' }), {
      body: '',
    });
    assert.deepEqual(previous, original);
  });

  it('should leave unchanged provider content out of the requested update', () => {
    const previous = {
      ...delivery(),
      pullRequest: { pullRequestNodeId: 'pr', pullRequestNumber: 12 },
    };
    assert.deepEqual(deliveryContentUpdate(previous, previous), {});
    assert.deepEqual(deliveryContentUpdate(previous, { title: 'new title', body: previous.body }), {
      title: 'new title',
    });
  });
});
