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

  it('should preserve the exact admitted github comment', () => {
    const body = '  Please keep this **exact**.\n\nSecond paragraph.  ';

    assert.equal(githubNotificationCommentPresentation(body), body);
  });
});
