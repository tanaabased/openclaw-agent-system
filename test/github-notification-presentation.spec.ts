import assert from 'node:assert/strict';

import githubNotificationMessage, {
  githubNotificationMarkdownCode,
  githubNotificationMarkdownText,
  githubNotificationQuote,
} from '../channels/github/presentation/card.ts';

describe('channels/github/presentation', () => {
  it('should delimit literal machine values without escaping their contents', () => {
    for (const [value, expected] of [
      ['openai/model', '`openai/model`'],
      ['high', '`high`'],
      ['  path/[a]*_b\\c  ', '`path/[a]*_b\\c`'],
      ['a`b``c', '```a`b``c```'],
      ['`value`', '`` `value` ``'],
      ['``', '``` `` ```'],
      ['one\n\tline', '`one line`'],
    ]) {
      assert.equal(githubNotificationMarkdownCode(value!), expected);
    }
    assert.throws(() => githubNotificationMarkdownCode('  '), /must not be empty/);
  });

  it('should preserve nested markdown and whitespace inside one complete quote', () => {
    assert.equal(
      githubNotificationQuote(
        '## Title\r\n\r\n- One\n  - Two\n\n```ts\n  code();  \n```\n\n> Author quote',
      ),
      '> ## Title\n>\n> - One\n>   - Two\n>\n> ```ts\n>   code();  \n> ```\n>\n> > Author quote',
    );
  });
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
        '> ## 📣 Comment received',
        '>',
        '> - **Source:** Approved comment',
        '> - **Delivery:** Private response path',
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
        '> ## ✅ Work complete',
        '>',
        '> The requested change is ready.',
        '>',
        '> **Validation:** All checks passed.',
      ].join('\n'),
    );
  });

  it('should escape provider text', () => {
    assert.equal(
      githubNotificationMarkdownText(' Michael *[reviewed]* this '),
      'Michael \\*\\[reviewed\\]\\* this',
    );
  });
});
