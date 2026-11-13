import assert from 'node:assert/strict';
import {
  githubCommentCard,
  githubNotificationCommentPresentation,
} from '../channels/github/presentation/comment.ts';
import feedbackResponse, {
  feedbackReplyPresentation,
} from '../channels/github/presentation/feedback-response.ts';
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
        '> ## 🔀 Pull request',
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
        '  [@tanaabot](https://github.com/tanaabot) Please check [the build](https://github.com/tanaabased/example/actions).',
        '',
        '## Notes',
        '',
        '- Keep `code` exact.',
        '- Ask [@octocat](https://github.com/octocat) about #12.  ',
        '',
        '> Quoted context',
        '',
        '```ts',
        'const mention = "@tanaabot";',
        '```',
        '',
        '&nbsp;  ',
        '*[Comment ↗](https://github.com/tanaabased/openclaw-agent-system/issues/46#issuecomment-123) from [@pirog](https://github.com/pirog)*',
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
      assert.ok(card.startsWith('> - [@recipient](https://github.com/recipient) item\n>\n> ```ts'));
      assert.ok(card.includes('> run();\n> ```\n>\n> > context'));
      assert.ok(
        card.endsWith(
          `> &nbsp;  \n> *[${label} ↗](${url}) ${connector} [@posting-agent](https://github.com/posting-agent)*`,
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
    const missingAuthor = githubCommentCard({
      body: 'Original text.',
      label: 'Plan assessment',
      connector: 'by',
      publication: { url },
    });
    assert.ok(missingAuthor.includes('by author unavailable*'));
  });

  it('should preserve provider content and normalize line endings without outer quotes', () => {
    const presentation = githubNotificationCommentPresentation({
      author: { label: 'pirog', url: 'https://github.com/pirog' },
      body: '@tanaabot first\r\n\r\nsecond\rthird',
      item: {
        label: 'example/repo#12',
        url: 'https://github.com/example/repo/pull/12#issuecomment-91',
      },
    });
    assert.ok(
      presentation.includes('[@tanaabot](https://github.com/tanaabot) first\n\nsecond\nthird'),
    );
    assert.ok(
      presentation.includes(
        '[Comment ↗](https://github.com/example/repo/pull/12#issuecomment-91) from [@pirog]',
      ),
    );
    assert.ok(!presentation.startsWith('>'));
  });
});

describe('channels/github/presentation/feedback-response', () => {
  const url = 'https://github.com/owner/repo/issues/3#issuecomment-99';

  it('should decorate draft and published replies and announcements only in local cards', () => {
    for (const publication of [{ draft: true }, { url }] as const) {
      for (const label of ['Reply', 'PR announcement'] as const) {
        const body = 'Thanks, @octocat. See `@literal` and [@linked](https://github.com/already).';
        const card = githubCommentCard({
          body,
          author: { label: 'poster', url: 'https://github.com/poster' },
          label,
          connector: label === 'Reply' ? 'from' : 'by',
          publication,
        });
        assert.ok(card.includes('[@octocat](https://github.com/octocat)'));
        assert.ok(card.includes('`@literal`'));
        assert.ok(card.includes('[@linked](https://github.com/already)'));
        assert.equal(
          body,
          'Thanks, @octocat. See `@literal` and [@linked](https://github.com/already).',
        );
      }
    }
  });

  it('should show an identical answer only in its exact linked reply card', () => {
    const input = {
      sourcePresentation: '> Incoming question with its own source link.',
      privateText: 'The fix covers queued comments.',
      publicReply: { author: 'receiver', text: 'The fix covers queued comments.' },
      publication: { url },
    };
    assert.equal(
      feedbackResponse(input),
      feedbackReplyPresentation('receiver', input.publicReply.text, url),
    );
  });

  it('should consolidate the answer when publication adds the verified commenter prefix', () => {
    const text = '@author\n\nThe fix covers queued comments.';
    assert.equal(
      feedbackResponse({
        privateText: 'The fix covers queued comments.\r\n',
        publicReply: { author: 'receiver', text },
        publication: { url },
      }),
      feedbackReplyPresentation('receiver', text, url),
    );
  });

  it('should preserve distinct private information outside the exact public quote', () => {
    const privateText =
      'Private evidence: the runtime probe is still pending.\n\n```ts\nrun();\n```';
    const text = '@author\n\nThe source repair is complete.';
    const presentation = feedbackResponse({
      privateText,
      publicReply: { author: 'receiver', text },
      publication: { url },
    });
    assert.ok(presentation.includes(privateText));
    assert.ok(presentation.includes(feedbackReplyPresentation('receiver', text, url)));
  });

  it('should retain the private answer when no public reply is requested', () => {
    const text = 'Answer for the publishing account only.';
    const presentation = feedbackResponse({
      privateText: text,
      publication: { withheld: 'feedback-private-only' },
    });
    assert.ok(presentation.includes(text));
    assert.ok(!presentation.includes('Reply draft'));
    assert.ok(!presentation.includes('[Reply ↗]'));
  });

  it('should keep an uncertain outcome visible without duplicating its draft answer', () => {
    const text = 'The answer is retained.';
    const presentation = feedbackResponse({
      privateText: text,
      publicReply: { author: 'receiver', text },
      publication: { withheld: 'github-notification-publication-unconfirmed' },
    });
    assert.ok(presentation.includes(feedbackReplyPresentation('receiver', text)));
    assert.ok(presentation.includes('unconfirmed'));
    assert.ok(!presentation.includes('[Reply ↗]'));
    assert.equal(presentation.split(text).length - 1, 1);
  });

  it('should preserve attribution-bearing differences rather than heuristically merge answers', () => {
    const privateText = '@different-author\n\nKeep this distinction.';
    const presentation = feedbackResponse({
      privateText,
      publicReply: { author: 'receiver', text: '@author\n\nKeep this distinction.' },
      publication: { url },
    });
    assert.ok(presentation.includes(privateText));
    assert.ok(presentation.includes('> [@author](https://github.com/author)'));
  });
});
