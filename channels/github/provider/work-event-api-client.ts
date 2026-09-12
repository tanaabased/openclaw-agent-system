import githubDiagnostic from '../../../credentials/github-diagnostic.ts';
import {
  withProviderDiagnostic,
  type ProviderDiagnostic,
} from '../../../utils/provider-diagnostic.ts';
import {
  GitHubAccountClientError,
  type ConnectedGitHubAccountClient,
} from '../../../core/github-account-client.ts';
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
    _options?: ErrorOptions,
    readonly providerDiagnostic?: ProviderDiagnostic,
  ) {
    // Host error formatters traverse causes; retain only the safe provider evidence.
    super(withProviderDiagnostic(message, providerDiagnostic));
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
    let result;
    try {
      result = await this.#client.execute(['api', '--include', ...argv], stdin, {
        maxOutputBytes: 512 * 1024,
        timeoutMs: 30_000,
      });
    } catch (error) {
      throw new GitHubWorkEventClientError(
        'github-notification-request-failed',
        `GitHub could not provide ${label} control facts.`,
        {},
        undefined,
        error instanceof GitHubAccountClientError
          ? (error.providerDiagnostic ?? githubDiagnostic({}))
          : githubDiagnostic({}),
      );
    }
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
        githubDiagnostic({ timedOut: result.timedOut }),
      );
    }
    if (result.timedOut || result.truncated) {
      throw new GitHubWorkEventClientError(
        'github-notification-response-bounded',
        `The GitHub ${label} response exceeded its runtime boundary.`,
        response.rateLimit,
        undefined,
        githubDiagnostic({
          status: response.status,
          timedOut: result.timedOut,
          ...response.rateLimit,
        }),
      );
    }
    if (result.exitCode !== 0 || response.status < 200 || response.status >= 300) {
      throw new GitHubWorkEventClientError(
        response.status === 404
          ? 'github-notification-resource-missing'
          : 'github-notification-request-failed',
        `GitHub could not provide ${label} control facts.`,
        response.rateLimit,
        undefined,
        githubDiagnostic({
          status: response.status,
          timedOut: result.timedOut,
          ...response.rateLimit,
        }),
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
