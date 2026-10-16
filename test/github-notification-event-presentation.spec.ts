import assert from 'node:assert/strict';

import githubNotificationAssignmentAcknowledgment, {
  githubNotificationAssignmentAcknowledgments,
  githubNotificationGuidedAssignmentAcknowledgments,
} from '../channels/github/events/assignment-acknowledgment.ts';
import { githubNotificationAssignmentCard } from '../channels/github/events/assignment.ts';
import { githubNotificationImplementationCard } from '../channels/github/events/implementation.ts';
import { githubNotificationPublicationText } from '../channels/github/publication/publication.ts';

describe('channels/github/events/presentation', () => {
  it('should render a linked assignment directive through the shared card grammar', () => {
    assert.equal(
      githubNotificationAssignmentCard(
        {
          emoji: '📥',
          item: {
            kind: 'Issue',
            label: 'tanaabased/example#12',
            url: 'https://github.com/tanaabased/example/issues/12',
          },
          sender: {
            id: 'U_actor',
            label: 'pirog',
            url: 'https://github.com/pirog',
          },
          timestamp: 1_755_259_200_000,
        },
        'work',
      ),
      [
        '> ## 📥 Issue assigned',
        '>',
        '> [@pirog](https://github.com/pirog) assigned you to [tanaabased/example#12](https://github.com/tanaabased/example/issues/12). Please begin working on it in `work` mode.',
      ].join('\n'),
    );
  });

  it('should render a guided assignment as prepared and waiting', () => {
    assert.match(
      githubNotificationAssignmentCard(
        {
          emoji: '📥',
          item: {
            kind: 'Issue',
            label: 'tanaabased/example#12',
            url: 'https://github.com/tanaabased/example/issues/12',
          },
          sender: {
            id: 'U_actor',
            label: 'pirog',
            url: 'https://github.com/pirog',
          },
          timestamp: 1_755_259_200_000,
        },
        'guided',
      ),
      /workspace is prepared; wait for operator direction in `guided` mode/u,
    );
  });

  it('should render the private implementation continuation through the shared card grammar', () => {
    assert.equal(
      githubNotificationImplementationCard(12),
      [
        '> ## 🛠️ Implementation started',
        '>',
        '> The public plan for issue #12 is published. Carry it out now in `work` mode, ending with one local commit. Lifecycle delivery follows.',
      ].join('\n'),
    );
  });

  it('should select varied safe acknowledgments deterministically by assignment', () => {
    assert.equal(githubNotificationAssignmentAcknowledgments.length, 32);
    assert.equal(
      new Set(githubNotificationAssignmentAcknowledgments).size,
      githubNotificationAssignmentAcknowledgments.length,
    );
    for (const text of githubNotificationAssignmentAcknowledgments) {
      assert.equal(githubNotificationPublicationText('initial-acknowledgment', [{ text }]), text);
    }
    assert.equal(githubNotificationGuidedAssignmentAcknowledgments.length, 12);
    assert.equal(
      new Set(githubNotificationGuidedAssignmentAcknowledgments).size,
      githubNotificationGuidedAssignmentAcknowledgments.length,
    );
    for (const text of githubNotificationGuidedAssignmentAcknowledgments) {
      assert.equal(githubNotificationPublicationText('initial-acknowledgment', [{ text }]), text);
      assert.match(text, /wait|ready|standing by/u);
    }
    const selected = githubNotificationAssignmentAcknowledgment('tanaabot', 'EV_assignment');
    assert.equal(githubNotificationAssignmentAcknowledgment('tanaabot', 'EV_assignment'), selected);
    assert.ok(
      new Set(
        Array.from({ length: 64 }, (_, index) =>
          githubNotificationAssignmentAcknowledgment('tanaabot', `EV_assignment_${index}`),
        ),
      ).size >= 16,
    );
    assert.equal(
      githubNotificationAssignmentAcknowledgment('tanaabot', 'EV_guided', 'guided'),
      githubNotificationAssignmentAcknowledgment('tanaabot', 'EV_guided', 'guided'),
    );
  });
});
