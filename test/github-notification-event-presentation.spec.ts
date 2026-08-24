import assert from 'node:assert/strict';

import githubNotificationAssignmentAcknowledgment, {
  githubNotificationAssignmentAcknowledgments,
} from '../channels/github/events/assignment-acknowledgment.ts';
import { githubNotificationAssignmentCard } from '../channels/github/events/assignment.ts';
import { githubNotificationCommentPresentation } from '../channels/github/events/comment.ts';
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
        '## 📥 Issue assigned',
        '',
        '[@pirog](https://github.com/pirog) assigned you to [tanaabased/example#12](https://github.com/tanaabased/example/issues/12). Please begin working on it in `work` mode.',
      ].join('\n'),
    );
  });

  it('should render the private implementation continuation through the shared card grammar', () => {
    assert.equal(
      githubNotificationImplementationCard(),
      [
        '## 🛠️ Implementation started',
        '',
        'The public plan is published. Carry it out now in `work` mode.',
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
    const selected = githubNotificationAssignmentAcknowledgment('tanaabot', 'EV_assignment');
    assert.equal(githubNotificationAssignmentAcknowledgment('tanaabot', 'EV_assignment'), selected);
    assert.ok(
      new Set(
        Array.from({ length: 64 }, (_, index) =>
          githubNotificationAssignmentAcknowledgment('tanaabot', `EV_assignment_${index}`),
        ),
      ).size >= 16,
    );
  });

  it('should render trusted comment identity around the exact author prose', () => {
    const body = [
      '  @tanaabot Please check [the build](https://github.com/tanaabased/example/actions).',
      '',
      '## Notes',
      '',
      '- Keep `code` exact.',
      '- Ask @octocat about #12.  ',
    ].join('\n');
    const start = body.indexOf('@tanaabot');

    assert.equal(
      githubNotificationCommentPresentation({
        agent: { emoji: '📬', label: 'Notification Data', url: '/openclaw/agents' },
        author: { label: 'pirog', url: 'https://github.com/pirog' },
        body,
        item: {
          label: 'tanaabased/openclaw-agent-system#46',
          url: 'https://github.com/tanaabased/openclaw-agent-system/issues/46#issuecomment-123',
        },
        mentions: [{ end: start + '@tanaabot'.length, start }],
      }),
      [
        '  📬 [Notification Data](/openclaw/agents) Please check [the build](https://github.com/tanaabased/example/actions).',
        '',
        '## Notes',
        '',
        '- Keep `code` exact.',
        '- Ask @octocat about #12.  ',
        '',
        '> _[@pirog](https://github.com/pirog) mentioned Notification Data on [tanaabased/openclaw-agent-system#46](https://github.com/tanaabased/openclaw-agent-system/issues/46#issuecomment-123)._',
      ].join('\n'),
    );
  });
});
