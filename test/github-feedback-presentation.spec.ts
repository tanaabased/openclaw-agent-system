import assert from 'node:assert/strict';
import { githubNotificationCommentPresentation } from '../channels/github/presentation/comment.ts';
import {
  githubNotificationPullRequestHandoffComment,
  githubNotificationPullRequestOpenedCard,
} from '../channels/github/presentation/pull-request-opened.ts';
import { githubNotificationPublicationText } from '../channels/github/publication/publication.ts';

describe('channels/github/presentation/feedback', () => {
  it('should render the pull request handoff for private and github surfaces', () => {
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
    const publicText = githubNotificationPullRequestHandoffComment(input);
    assert.match(publicText, /^## 🔀 Pull request opened\n\n/u);
    assert.equal(
      publicText,
      privateText
        .split('\n')
        .map((line) => (line === '>' ? '' : line.slice(2)))
        .join('\n'),
    );
    assert.equal(
      githubNotificationPublicationText('pull-request-handoff', [{ text: publicText }]),
      publicText,
    );
    assert.throws(() =>
      githubNotificationPullRequestHandoffComment({ ...input, pullRequestNumber: 0 }),
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
        '> ## 💬 From [@pirog](https://github.com/pirog)',
        '>',
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
        '> [View comment on tanaabased/openclaw-agent-system#46 ↗](https://github.com/tanaabased/openclaw-agent-system/issues/46#issuecomment-123)',
      ].join('\n'),
    );
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
    assert.ok(presentation.endsWith('/pull/12#issuecomment-91)'));
  });
});
