import assert from 'node:assert/strict';

import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import GitHubIssueCommentClient from '../channels/github/provider/issue-comment-client.ts';
import GitHubReviewClient from '../channels/github/provider/review-client.ts';
import { account } from './github-intake-fixture.ts';

/** exercise provider parsing with projected responses and no external calls. */
export default function commentProviderFixture(read: (number: number) => unknown[]) {
  const api = new GitHubWorkEventApiClient({
    identity: account,
    async execute(argv) {
      assert.equal(argv[argv.indexOf('--method') + 1], 'GET');
      const endpoint = argv.find((value) => value.startsWith('/repos/'))!;
      const comments = /^\/repos\/owner\/repo\/issues\/(\d+)\/comments$/u.exec(endpoint);
      assert.ok(
        comments || /^\/repos\/owner\/repo\/pulls\/\d+\/(reviews|comments)$/u.test(endpoint),
      );
      return {
        exitCode: 0,
        stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(comments ? read(Number(comments[1])) : []),
        stderr: '',
        timedOut: false,
        truncated: false,
      };
    },
  });
  return Object.assign(new GitHubIssueCommentClient(api, 8000), {
    reviews: new GitHubReviewClient(api, 8000),
  });
}
