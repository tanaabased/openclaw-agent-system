import githubDiagnostic, { githubCliDiagnostic } from '../../../credentials/github-diagnostic.ts';
import {
  withProviderDiagnostic,
  type ProviderDiagnostic,
} from '../../../utils/provider-diagnostic.ts';
import {
  GitHubAccountClientError,
  type GitHubAccountExecutionOptions,
  type ConnectedGitHubAccountClient,
} from '../../../core/github-account-client.ts';
import { parseGitHubApiResponse, type GitHubRateLimit } from './api-response.ts';
import type { GitHubIdentity } from './work-item.ts';
import retryGitHubRead from '../../../core/github-read-retry.ts';

export interface GitHubApiPage<T> {
  etag?: string;
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

type ApiAccount = Pick<
  ConnectedGitHubAccountClient,
  'execute' | 'identity' | 'observationScope' | 'credentialFingerprint'
>;

/** revalidate bounded REST reads against credential-scoped observations on every request. */
export default class GitHubWorkEventApiClient {
  static readonly #observations = new WeakMap<
    object,
    Map<string, { etag: string; page: GitHubApiPage<unknown>; bytes: number }>
  >();
  readonly #client: ApiAccount;
  #rateLimit: GitHubRateLimit = {};

  constructor(
    client: ApiAccount,
    private readonly retryRead = retryGitHubRead,
  ) {
    this.#client = client;
  }

  get identity(): GitHubIdentity {
    return { ...this.#client.identity, type: 'User' };
  }

  get rateLimit(): GitHubRateLimit {
    return { ...this.#rateLimit };
  }

  get observationScope(): object {
    return this.#client.observationScope ?? this.#client;
  }

  async request(
    argv: string[],
    label: string,
    stdin?: string,
    options?: GitHubAccountExecutionOptions,
  ): Promise<GitHubApiPage<unknown>> {
    const scope = this.observationScope;
    const observations =
      GitHubWorkEventApiClient.#observations.get(scope) ??
      new Map<string, { etag: string; page: GitHubApiPage<unknown>; bytes: number }>();
    GitHubWorkEventApiClient.#observations.set(scope, observations);
    const methodIndex = argv.findIndex((value) => value === '--method' || value === '-X');
    const method =
      methodIndex >= 0
        ? argv[methodIndex + 1]
        : argv.some((value) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(value))
          ? 'POST'
          : 'GET';
    const graphql = argv.some((value) => value.replace(/^\//u, '') === 'graphql');
    const invalidates = method !== 'GET' && !graphql;
    const conditional =
      method === 'GET' &&
      !argv.some(
        (value) =>
          value.replace(/^\//u, '') === 'graphql' ||
          /^(?:if-none-match|if-modified-since):/iu.test(value),
      );
    const key = JSON.stringify([
      this.#client.identity,
      this.#client.credentialFingerprint,
      argv,
      stdin,
    ]);
    const cached = conditional ? observations.get(key) : undefined;
    if (invalidates) observations.clear();
    try {
      return await this.#request(
        argv,
        label,
        stdin,
        options,
        method === 'GET' && !graphql,
        cached,
        (page) => {
          observations.delete(key);
          if (!conditional || !page.etag) return;
          const bytes = Buffer.byteLength(JSON.stringify(page)) + Buffer.byteLength(key);
          if (bytes > 8 * 1024 * 1024) return;
          observations.set(key, { etag: page.etag, page: structuredClone(page), bytes });
          let total = [...observations.values()].reduce((sum, value) => sum + value.bytes, 0);
          while (observations.size > 128 || total > 8 * 1024 * 1024) {
            const oldest = observations.keys().next().value!;
            total -= observations.get(oldest)!.bytes;
            observations.delete(oldest);
          }
        },
      );
    } catch (error) {
      observations.delete(key);
      throw error;
    } finally {
      if (invalidates) observations.clear();
    }
  }

  async #request(
    argv: string[],
    label: string,
    stdin: string | undefined,
    options: GitHubAccountExecutionOptions | undefined,
    read: boolean,
    cached: { etag: string; page: GitHubApiPage<unknown> } | undefined,
    retain: (page: GitHubApiPage<unknown>) => void,
  ): Promise<GitHubApiPage<unknown>> {
    let result;
    try {
      const execute = (timeoutMs: number) =>
        this.#client.execute(
          [
            'api',
            '--include',
            ...(cached ? ['--header', `If-None-Match: ${cached.etag}`] : []),
            ...argv,
          ],
          stdin,
          {
            profileOperation: label.replaceAll(' ', '-'),
            maxOutputBytes: 512 * 1024,
            ...options,
            timeoutMs,
          },
        );
      result = read
        ? await this.retryRead(execute, options)
        : await execute(options?.timeoutMs ?? 30_000);
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
        githubCliDiagnostic(result),
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
    // gh reports HTTP 304 as exit 1; it is successful only for our conditional read.
    if ((result.exitCode === 0 || result.exitCode === 1) && response.status === 304 && cached) {
      const page = { ...structuredClone(cached.page), etag: response.etag ?? cached.etag };
      retain(page);
      return page;
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
          providerMessage: githubCliDiagnostic(result).providerMessage,
          rateLimited: githubCliDiagnostic(result).classification === 'rate-limit',
        }),
      );
    }
    try {
      const page = {
        ...(response.etag ? { etag: response.etag } : {}),
        hasNextPage: response.hasNextPage,
        value:
          response.status === 204 && !response.body.trim()
            ? null
            : (JSON.parse(response.body) as unknown),
      };
      retain(page);
      return page;
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
