import assert from 'node:assert/strict';

import githubNotificationMessage, {
  githubNotificationBlockquote,
  githubNotificationMarkdownText,
  githubNotificationProposedReplyHeading,
} from '../channels/github/utils/presentation.ts';
import githubNotificationQuotedCandidate, {
  GitHubNotificationQuotedCandidateError,
} from '../channels/github/utils/quoted-candidate.ts';

describe('channels/github/utils/presentation', () => {
  it('should render one rich message with an optional concise note', () => {
    assert.equal(
      githubNotificationMessage({
        emoji: '💬',
        note: {
          label: 'Mode',
          text: 'Reply — answer from recorded evidence without using tools.',
        },
        summary:
          'Michael mentioned you on [tanaabased/example#7](https://github.com/tanaabased/example/issues/7).',
        title: 'Comment received',
      }),
      [
        '## 💬 Comment received',
        '',
        'Michael mentioned you on [tanaabased/example#7](https://github.com/tanaabased/example/issues/7).',
        '',
        '**Mode:** Reply — answer from recorded evidence without using tools.',
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

  it('should extract one quoted candidate outside fenced examples', () => {
    const response = [
      '## 💬 Comment answered',
      '',
      'The recorded evidence supports a bounded reply.',
      '',
      '## Response',
      '',
      '```markdown',
      githubNotificationProposedReplyHeading,
      '> not the real candidate',
      '```',
      '',
      githubNotificationProposedReplyHeading,
      '',
      '> The plan is recorded.',
    ].join('\n');

    assert.equal(
      githubNotificationQuotedCandidate(response, githubNotificationProposedReplyHeading),
      'The plan is recorded.',
    );
  });

  it('should reject missing duplicate empty or partly unquoted candidates', () => {
    for (const response of [
      '## Response\n\nPrivate only.',
      [
        githubNotificationProposedReplyHeading,
        '',
        '> First.',
        '',
        githubNotificationProposedReplyHeading,
        '',
        '> Second.',
      ].join('\n'),
      `${githubNotificationProposedReplyHeading}\n`,
      `${githubNotificationProposedReplyHeading}\n\n> Public.\nPrivate.`,
    ]) {
      assert.throws(
        () => githubNotificationQuotedCandidate(response, githubNotificationProposedReplyHeading),
        GitHubNotificationQuotedCandidateError,
      );
    }
  });
});
