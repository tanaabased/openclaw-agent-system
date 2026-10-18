import type { AgentSystemCliResult } from '../api/types.ts';
import { parseGitHubApiResponse } from '../channels/github/provider/api-response.ts';
import { githubCliDiagnostic } from '../credentials/github-diagnostic.ts';
import { providerDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';

/** Share provider deadlines across connections; never sleep or replay an uncertain write. */
export default class GitHubRequestCooldown {
  readonly #blocked = new Map<string, { until: number; diagnostic: ProviderDiagnostic }>();
  constructor(private readonly now: () => number = Date.now) {}

  inspect(account: string, argv: string[]) {
    const now = this.now();
    for (const [key, value] of this.#blocked) if (value.until <= now) this.#blocked.delete(key);
    const bucket = argv.some((arg) => /^\/?search\//.test(arg))
      ? 'search'
      : argv.some((arg) => arg === 'graphql' || arg === '/graphql')
        ? 'graphql'
        : 'core';
    const blocked = [
      this.#blocked.get(`${account}:account`),
      this.#blocked.get(`${account}:${bucket}`),
    ]
      .filter((entry) => entry !== undefined)
      .sort((a, b) => b.until - a.until)[0];
    if (!blocked) return undefined;
    return providerDiagnostic('github', 'api-request', 'rate-limit', {
      ...blocked.diagnostic,
      localBackoffMs: blocked.until - now,
    });
  }

  observe(account: string, result: AgentSystemCliResult) {
    const diagnostic = githubCliDiagnostic(result);
    let rate;
    try {
      rate = parseGitHubApiResponse(result.stdout).rateLimit;
    } catch {
      /* CLI-only evidence is still useful. */
    }
    const exhausted = rate?.remaining === 0;
    if (!exhausted && diagnostic.classification !== 'rate-limit') return;
    const now = this.now();
    const until = Math.max(
      now + (diagnostic.retryAfterMs ?? 60000),
      exhausted ? (diagnostic.resetAt ?? 0) : 0,
    );
    const bucket = exhausted && diagnostic.quotaScope ? diagnostic.quotaScope : 'account';
    const key = `${account}:${bucket}`;
    if ((this.#blocked.get(key)?.until ?? 0) >= until) return;
    // Expire old accounts and bound a long-lived Gateway's retained metadata.
    for (const [key, value] of this.#blocked) if (value.until <= now) this.#blocked.delete(key);
    if (this.#blocked.size >= 1024) this.#blocked.delete(this.#blocked.keys().next().value!);
    this.#blocked.set(key, { until, diagnostic });
  }
}
