import assert from 'node:assert/strict';

import { githubNotificationAssignmentCard } from '../channels/github/events/assignment.ts';
import { githubNotificationCommentPresentation } from '../channels/github/events/comment.ts';

describe('channels/github/events/presentation', () => {
  it('should render lifecycle-projected assignment facts through the shared card grammar', () => {
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
        'Work',
      ),
      [
        '## 📥 Issue assignment received',
        '',
        '[@pirog](https://github.com/pirog) assigned you [tanaabased/example#12](https://github.com/tanaabased/example/issues/12).',
        '',
        '**Mode:** Work',
      ].join('\n'),
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
