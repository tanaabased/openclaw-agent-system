import assert from 'node:assert/strict';

import assignmentCard from '../channels/github/presentation/assignment-card.ts';
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

  it('should render assigned issues with a plain attribution and source line', () => {
    assert.equal(
      assignmentCard({
        emoji: '📥',
        item: {
          kind: 'Issue',
          label: 'tanaabased/openclaw-agent-system#675',
          url: 'https://github.com/tanaabased/openclaw-agent-system/issues/675',
        },
        sender: { label: 'pirog', url: 'https://github.com/pirog' },
      }),
      [
        '---',
        '[@pirog](https://github.com/pirog) · [tanaabased/openclaw-agent-system#675](https://github.com/tanaabased/openclaw-agent-system/issues/675)',
        '',
        'assigned you to tanaabased/openclaw-agent-system#675.',
        '',
        '---',
      ].join('\n'),
    );
  });

  it('should keep request cards in the quoted notification style', () => {
    assert.equal(
      assignmentCard({
        emoji: '📥',
        item: {
          kind: 'Issue',
          label: 'tanaabased/openclaw-agent-system#675',
          url: 'https://github.com/tanaabased/openclaw-agent-system/issues/675',
        },
      }),
      [
        '> ## 📥 Issue requested',
        '>',
        '> You requested [tanaabased/openclaw-agent-system#675](https://github.com/tanaabased/openclaw-agent-system/issues/675).',
      ].join('\n'),
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
