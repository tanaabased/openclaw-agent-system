import type { ConnectedGitHubAccountClient } from '../../../core/github-account-client.ts';
import { parseGitHubApiResponse, type GitHubRateLimit } from './api-response.ts';
import type { GitHubIdentity } from './work-item.ts';

export interface GitHubApiPage<T> {
  hasNextPage: boolean;
  value: T;
}

export class GitHubWorkEventClientError extends Error {
  override name = 'GitHubWorkEventClientError';

  constructor(
    readonly code: string,
    message: string,
    readonly rateLimit: GitHubRateLimit = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function githubRepositoryEndpoint(owner: string, name: string): string {
  const segment = /^[A-Za-z0-9_.-]+$/u;
  if (!segment.test(owner) || !segment.test(name)) {
    throw new Error('GitHub repository coordinates are invalid.');
  }
  return `/repos/${owner}/${name}`;
}

export function githubWorkItemEndpoint(owner: string, name: string, number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('GitHub work-item numbers must be positive safe integers.');
  }
  return `${githubRepositoryEndpoint(owner, name)}/issues/${number}`;
}

/** Execute bounded fixed-shape GitHub API requests and retain only rate-limit metadata. */
export default class GitHubWorkEventApiClient {
  readonly #client: ConnectedGitHubAccountClient;
  #rateLimit: GitHubRateLimit = {};

  constructor(client: ConnectedGitHubAccountClient) {
    this.#client = client;
  }

  get identity(): GitHubIdentity {
    return { ...this.#client.identity, type: 'User' };
  }

  get rateLimit(): GitHubRateLimit {
    return { ...this.#rateLimit };
  }

  async request(argv: string[], label: string, stdin?: string): Promise<GitHubApiPage<unknown>> {
    const result = await this.#client.execute(['api', '--include', ...argv], stdin, {
      maxOutputBytes: 512 * 1024,
      timeoutMs: 30_000,
    });
    let response;
    try {
      response = parseGitHubApiResponse(result.stdout);
      this.#rateLimit = response.rateLimit;
    } catch (error) {
      throw new GitHubWorkEventClientError(
        'github-notification-response-invalid',
        `GitHub returned an invalid ${label} response.`,
        {},
        { cause: error },
      );
    }
    if (result.timedOut || result.truncated) {
      throw new GitHubWorkEventClientError(
        'github-notification-response-bounded',
        `The GitHub ${label} response exceeded its runtime boundary.`,
        response.rateLimit,
      );
    }
    if (result.exitCode !== 0 || response.status < 200 || response.status >= 300) {
      throw new GitHubWorkEventClientError(
        response.status === 404
          ? 'github-notification-resource-missing'
          : 'github-notification-request-failed',
        `GitHub could not provide ${label} control facts.`,
        response.rateLimit,
      );
    }
    try {
      return { hasNextPage: response.hasNextPage, value: JSON.parse(response.body) as unknown };
    } catch (error) {
      throw new GitHubWorkEventClientError(
        'github-notification-response-invalid',
        `GitHub returned invalid ${label} data.`,
        response.rateLimit,
        { cause: error },
      );
    }
  }
}
