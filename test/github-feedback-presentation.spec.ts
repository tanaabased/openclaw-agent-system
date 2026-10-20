import assert from 'node:assert/strict';
import {
  githubCommentCard,
  githubNotificationCommentPresentation,
} from '../channels/github/presentation/comment.ts';
import { githubNotificationPullRequestOpenedCard } from '../channels/github/presentation/pull-request-opened.ts';

describe('channels/github/presentation/feedback', () => {
  it('should render the private pull request card', () => {
    const input = {
      issueNumber: 12,
      pullRequestNumber: 45,
      repositoryName: 'example',
      repositoryOwner: 'tanaabased',
    };
    const privateText = githubNotificationPullRequestOpenedCard(input);
    assert.equal(
      privateText,
      [
        '> ## 🔀 Pull request opened',
        '>',
        '> - **Issue:** [tanaabased/example#12](https://github.com/tanaabased/example/issues/12)',
        '> - **Pull request:** [tanaabased/example#45](https://github.com/tanaabased/example/pull/45)',
        '> - **Comment flow:** This issue and its delivery pull request share this session; each reply returns to its originating item.',
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
      '',
      '> Quoted context',
      '',
      '```ts',
      'const mention = "@tanaabot";',
      '```',
    ].join('\n');

    assert.equal(
      githubNotificationCommentPresentation({
        author: { label: 'pirog', url: 'https://github.com/pirog' },
        body,
        item: {
          label: 'tanaabased/openclaw-agent-system#46',
          url: 'https://github.com/tanaabased/openclaw-agent-system/issues/46#issuecomment-123',
        },
      }),
      [
        '>   @tanaabot Please check [the build](https://github.com/tanaabased/example/actions).',
        '>',
        '> ## Notes',
        '>',
        '> - Keep `code` exact.',
        '> - Ask @octocat about #12.  ',
        '>',
        '> > Quoted context',
        '>',
        '> ```ts',
        '> const mention = "@tanaabot";',
        '> ```',
        '>',
        '> <br>',
        '>',
        '> *[Comment ↗](https://github.com/tanaabased/openclaw-agent-system/issues/46#issuecomment-123) from [@pirog](https://github.com/pirog)*',
      ].join('\n'),
    );
  });

  it('should render all five labels with exact source attribution and an unlinked draft', () => {
    const body = '- @recipient item\r\n\r\n```ts\r\nrun();\r\n```\r\n\r\n> context';
    const author = { label: 'posting-agent', url: 'https://github.com/posting-agent' };
    const url = 'https://github.com/owner/repo/issues/3#issuecomment-8';
    for (const label of [
      'Comment',
      'Reply',
      'Review comment',
      'Plan assessment',
      'PR announcement',
    ] as const) {
      const connector = label === 'Plan assessment' || label === 'PR announcement' ? 'by' : 'from';
      const card = githubCommentCard({ body, author, label, connector, publication: { url } });
      assert.ok(card.startsWith('> - @recipient item\n>\n> ```ts'));
      assert.ok(card.includes('> run();\n> ```\n>\n> > context'));
      assert.ok(
        card.endsWith(
          `> <br>\n>\n> *[${label} ↗](${url}) ${connector} [@posting-agent](https://github.com/posting-agent)*`,
        ),
      );
      const draft = githubCommentCard({
        body,
        author,
        label,
        connector,
        publication: { draft: true },
      });
      assert.ok(
        draft.endsWith(
          `> *${label} draft ${connector} [@posting-agent](https://github.com/posting-agent)*`,
        ),
      );
      assert.ok(!draft.includes(url));
    }
    const legacy = githubCommentCard({
      body: 'Original text.',
      label: 'Plan assessment',
      connector: 'by',
      publication: { url },
    });
    assert.ok(legacy.includes('by author unavailable*'));
  });

  it('should keep all provider line endings inside the comment quote', () => {
    const presentation = githubNotificationCommentPresentation({
      author: { label: 'pirog', url: 'https://github.com/pirog' },
      body: '@tanaabot first\r\n\r\nsecond\rthird',
      item: {
        label: 'example/repo#12',
        url: 'https://github.com/example/repo/pull/12#issuecomment-91',
      },
    });
    assert.ok(presentation.includes('> @tanaabot first\n>\n> second\n> third'));
    assert.ok(presentation.split('\n').every((line) => line.startsWith('>')));
    assert.ok(
      presentation.includes(
        '[Comment ↗](https://github.com/example/repo/pull/12#issuecomment-91) from [@pirog]',
      ),
    );
  });
});
