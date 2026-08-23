import assert from 'node:assert/strict';

import githubNotificationMessage, {
  githubNotificationMarkdownText,
} from '../channels/github/conversation/presentation/card.ts';
import { githubNotificationBlockquote } from '../channels/github/conversation/presentation/public-response.ts';

describe('channels/github/conversation/presentation', () => {
  it('should render one compact card with labeled facts', () => {
    assert.equal(
      githubNotificationMessage({
        emoji: '📣',
        facts: [
          { label: 'Source', value: 'Approved comment' },
          { label: 'Delivery', value: 'Private response path' },
        ],
        title: 'Comment received',
      }),
      [
        '## 📣 Comment received',
        '',
        '- **Source:** Approved comment',
        '- **Delivery:** Private response path',
      ].join('\n'),
    );
  });

  it('should retain a summary card for report outcomes', () => {
    assert.equal(
      githubNotificationMessage({
        emoji: '✅',
        note: { label: 'Validation', text: 'All checks passed.' },
        summary: 'The requested change is ready.',
        title: 'Work complete',
      }),
      [
        '## ✅ Work complete',
        '',
        'The requested change is ready.',
        '',
        '**Validation:** All checks passed.',
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
