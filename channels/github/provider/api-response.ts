export interface GitHubRateLimit {
  remaining?: number;
  resetAt?: number;
  retryAfterMs?: number;
}

export interface GitHubApiResponse {
  body: string;
  hasNextPage: boolean;
  rateLimit: GitHubRateLimit;
  status: number;
}

function finiteInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Parse one bounded `gh api --include` response without retaining response headers. */
export function parseGitHubApiResponse(value: string): GitHubApiResponse {
  const starts = [...value.matchAll(/^HTTP\/\S+\s+(\d{3})(?:\s+.*)?$/gmu)];
  const last = starts.at(-1);
  if (!last || last.index === undefined || !last[1]) {
    throw new Error('GitHub returned a response without an HTTP status line.');
  }
  const response = value.slice(last.index);
  const separator = /\r?\n\r?\n/u.exec(response);
  if (!separator || separator.index === undefined) {
    throw new Error('GitHub returned a response without a header boundary.');
  }
  const headerLines = response.slice(0, separator.index).split(/\r?\n/u);
  const headers = new Map<string, string>();
  for (const line of headerLines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const status = Number(last[1]);
  if (!Number.isSafeInteger(status)) throw new Error('GitHub returned an invalid HTTP status.');
  const remaining = finiteInteger(headers.get('x-ratelimit-remaining'));
  const resetSeconds = finiteInteger(headers.get('x-ratelimit-reset'));
  const retryAfterSeconds = finiteInteger(headers.get('retry-after'));
  return {
    body: response.slice(separator.index + separator[0].length),
    hasNextPage: /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"(?:,|$)/u.test(headers.get('link') ?? ''),
    rateLimit: {
      ...(remaining === undefined ? {} : { remaining }),
      ...(resetSeconds === undefined ? {} : { resetAt: resetSeconds * 1000 }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterMs: retryAfterSeconds * 1000 }),
    },
    status,
  };
}
