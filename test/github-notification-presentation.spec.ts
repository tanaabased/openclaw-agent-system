import assert from 'node:assert/strict';

import githubNotificationMessage, {
  githubNotificationMarkdownText,
} from '../channels/github/messages/presentation/card.ts';
import { githubNotificationBlockquote } from '../channels/github/messages/presentation/response-envelope.ts';

describe('channels/github/messages/presentation', () => {
  it('should render one rich message with an optional concise note', () => {
    assert.equal(
      githubNotificationMessage({
        emoji: '📣',
        note: {
          label: 'Delivery',
          text: 'Ready for the private response path.',
        },
        summary: 'The approved comment entered the assignment session.',
        title: 'Comment received',
      }),
      [
        '## 📣 Comment received',
        '',
        'The approved comment entered the assignment session.',
        '',
        '**Delivery:** Ready for the private response path.',
      ].join('\n'),
    );
  });

  it('should escape provider text and render multiline blockquotes', () => {
    assert.equal(
      githubNotificationMarkdownText(' Michael *[reviewed]* this '),
      'Michael \\*\\[reviewed\\]\\* this',
    );
    assert.equal(
      githubNotificationBlockquote('First line.\n\nSecond line.'),
      ['> First line.', '>', '> Second line.'].join('\n'),
    );
  });
});
