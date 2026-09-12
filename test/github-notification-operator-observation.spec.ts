import assert from 'node:assert/strict';

import observeControl from '../scenarios/issue-work-operator-access/observation.mjs';

function input(number = 1) {
  return {
    number,
    phase: 'assignment',
    configured: true,
    sessions: [
      {
        key: `agent:notification-data:agent-system-github:notification-data:direct:github:issue:r_fixture:${number}`,
        owner: { actor: { type: 'agent', id: 'notification-data' } },
        color: 'purple',
        category: 'GitHub Issues',
      },
    ],
    conversation: {
      acknowledgment: { status: 'published' },
      assignmentResponse: { status: 'withheld', reasonCode: 'github-notification-guided-waiting' },
      activeTurn: undefined as { eventId: string } | undefined,
      implementation: undefined as { status: string } | undefined,
    },
    evidence: {
      strictMissCount: 0,
      successfulFixtureResponseCount: 3,
      requestCount: 3,
      finalResponseCount: number,
    },
  };
}

describe('github operator-access completion observations', () => {
  it('should wait for the specific lifecycle checkpoint after the model has answered', () => {
    const selected = input();
    selected.conversation.activeTurn = { eventId: 'assignment' };
    assert.equal(observeControl(selected).ready, false);
    selected.conversation.activeTurn = undefined;
    assert.equal(observeControl(selected).ready, true);
    selected.conversation.assignmentResponse.status = 'pending';
    assert.equal(observeControl(selected).ready, false);
    selected.conversation.assignmentResponse.status = 'withheld';
    selected.conversation.acknowledgment.status = 'pending';
    assert.equal(observeControl(selected).ready, false);
  });

  it('should require saved fields for the exact routed session and preserve observations', () => {
    const selected = input();
    const before = structuredClone(selected);
    assert.equal(observeControl(selected).ready, true);
    assert.deepEqual(selected, before);
    selected.sessions[0]!.key = 'agent:other:direct:unrelated:1';
    assert.equal(observeControl(selected).ready, false);
    selected.sessions = before.sessions;
    selected.sessions[0]!.color = 'red';
    assert.equal(observeControl(selected).ready, false);
  });

  it('should require unpromoted controls to finish without any session decoration', () => {
    const selected = input(2);
    selected.configured = false;
    assert.equal(observeControl(selected).ready, false);
    Object.assign(selected.sessions[0]!, {
      owner: undefined,
      color: undefined,
      category: undefined,
    });
    assert.equal(observeControl(selected).ready, true);
    selected.evidence.strictMissCount = 1;
    assert.equal(observeControl(selected).ready, false);
  });

  it('should not treat a system model response as a completed implementation checkpoint', () => {
    const selected = input(4);
    selected.phase = 'implementation';
    selected.evidence.finalResponseCount = 5;
    selected.conversation.assignmentResponse.status = 'published';
    selected.conversation.activeTurn = { eventId: 'implementation' };
    selected.conversation.implementation = { status: 'pending' };
    assert.equal(observeControl(selected).ready, false);
    selected.conversation.activeTurn = undefined;
    selected.conversation.implementation.status = 'delivery-pending';
    assert.equal(observeControl(selected).ready, true);
    selected.evidence.finalResponseCount = 6;
    assert.equal(observeControl(selected).ready, false);
    selected.evidence.finalResponseCount = 5;
    selected.evidence.successfulFixtureResponseCount = 2;
    assert.equal(observeControl(selected).ready, false);
  });
});
