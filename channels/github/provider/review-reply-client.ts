import type GitHubReviewClient from './review-client.ts';
import {
  githubRepositoryEndpoint,
  type default as GitHubWorkEventApiClient,
} from './work-event-api-client.ts';

/** inline replies retain their original thread even when its diff position is outdated. */
export default class GitHubReviewReplyClient {
  constructor(
    readonly api: GitHubWorkEventApiClient,
    readonly reviews: GitHubReviewClient,
  ) {}

  async find(owner: string, name: string, number: number, root: number, marker: string) {
    let found: Awaited<ReturnType<GitHubReviewClient['getComment']>> | undefined;
    for (let page = 1; page <= 10; page++) {
      const result = await this.reviews.listComments(owner, name, number, page);
      const matches = result.values.filter(
        (comment) =>
          comment.replyToId === root &&
          comment.author?.nodeId === this.api.identity.nodeId &&
          comment.body.includes(marker),
      );
      if (matches.length > 1 || (found && matches.length))
        throw new Error('feedback-publication-ambiguous');
      if (matches[0]) {
        if (matches[0].bodyTruncated) throw new Error('feedback-publication-incomplete');
        found = matches[0];
      }
      if (result.nextPage === 1) return found;
    }
    throw new Error('feedback-publication-incomplete');
  }

  async create(owner: string, name: string, number: number, root: number, body: string) {
    if (
      ![number, root].every((value) => Number.isSafeInteger(value) && value > 0) ||
      !body ||
      body.length > 1024
    )
      throw new Error('feedback-publication-invalid');
    const response = await this.api.request(
      [
        '--method',
        'POST',
        `${githubRepositoryEndpoint(owner, name)}/pulls/${number}/comments/${root}/replies`,
        '--input',
        '-',
        '--jq',
        '.id',
      ],
      'review reply',
      JSON.stringify({ body }),
    );
    if (!Number.isSafeInteger(response.value) || Number(response.value) < 1)
      throw new Error('feedback-publication-receipt-invalid');
    const receipt = await this.reviews.getComment(owner, name, number, Number(response.value));
    if (
      receipt.replyToId !== root ||
      receipt.body !== body ||
      receipt.author?.nodeId !== this.api.identity.nodeId
    )
      throw new Error('feedback-publication-receipt-invalid');
    return receipt;
  }
}
