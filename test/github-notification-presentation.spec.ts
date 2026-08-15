import assert from 'node:assert/strict';

import githubNotificationMessage, {
  githubNotificationBlockquote,
  githubNotificationMarkdownText,
  githubNotificationToGitHubHeading,
} from '../channels/github/utils/presentation.ts';
import githubNotificationQuotedCandidate, {
  GitHubNotificationQuotedCandidateError,
} from '../channels/github/utils/quoted-candidate.ts';

describe('channels/github/utils/presentation', () => {
  it('should render one rich message with an optional concise note', () => {
    assert.equal(
      githubNotificationMessage({
        emoji: '📣',
        note: {
          label: 'Delivery',
          text: 'Ready for the explicit GitHub publication path.',
        },
        summary: 'The operator selected one bounded progress update.',
        title: 'Progress selected',
      }),
      [
        '## 📣 Progress selected',
        '',
        'The operator selected one bounded progress update.',
        '',
        '**Delivery:** Ready for the explicit GitHub publication path.',
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
      githubNotificationToGitHubHeading,
      '> not the real candidate',
      '```',
      '',
      githubNotificationToGitHubHeading,
      '',
      '> The plan is recorded.',
    ].join('\n');

    assert.equal(
      githubNotificationQuotedCandidate(response, githubNotificationToGitHubHeading),
      'The plan is recorded.',
    );
  });

  it('should reject missing duplicate empty or partly unquoted candidates', () => {
    for (const response of [
      '## Response\n\nPrivate only.',
      [
        githubNotificationToGitHubHeading,
        '',
        '> First.',
        '',
        githubNotificationToGitHubHeading,
        '',
        '> Second.',
      ].join('\n'),
      `${githubNotificationToGitHubHeading}\n`,
      `${githubNotificationToGitHubHeading}\n\n> Public.\nPrivate.`,
    ]) {
      assert.throws(
        () => githubNotificationQuotedCandidate(response, githubNotificationToGitHubHeading),
        GitHubNotificationQuotedCandidateError,
      );
    }
  });
});
