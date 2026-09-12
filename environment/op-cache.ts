import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import resolveOpCachePolicy, { type OpCachePolicy } from './op-cache-policy.ts';
import type { OpEnvironmentClient, OpEnvironmentLoadResult } from './op-service.ts';

type Snapshot = Extract<OpEnvironmentLoadResult, { status: 'loaded' }>;
type Entry = {
  agentId: string;
  fingerprint: string;
  requestOrder: number;
  credentialFingerprint: string;
  client?: Promise<OpEnvironmentClient>;
  pending?: Promise<OpEnvironmentLoadResult>;
  snapshot?: Snapshot;
  retrievedAt?: number;
  expiresAt?: number;
};

export function opDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function invalidatedOpLoad(): OpEnvironmentLoadResult {
  return {
    status: 'invalid',
    diagnostics: [
      {
        severity: 'error',
        code: 'op-cache-invalidated',
        fieldPath: '/environment',
        message: 'The OP credential generation changed; start a new operation.',
      },
    ],
  };
}

function freezeSnapshot(snapshot: Snapshot): Snapshot {
  Object.freeze(snapshot.set.values);
  Object.freeze(snapshot.set.sensitiveNames);
  Object.freeze(snapshot.set);
  for (const source of snapshot.sources) {
    Object.freeze(source.values);
    Object.freeze(source.sensitiveNames);
    Object.freeze(source);
  }
  Object.freeze(snapshot.sources);
  return Object.freeze(snapshot);
}

/** Process-local credential state. No permission, tool result, or provider error text is retained. */
export default class OpCache {
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();
  readonly #backoff = new Map<string, { failures: number; retryAt: number }>();
  #overflowRetryAt = 0;
  #policy: OpCachePolicy = resolveOpCachePolicy(undefined);
  #requestOrder = 0;
  #configuration: string | undefined;
  readonly #generations = new Map<string, object>();
  readonly #counts = {
    clientCreations: 0,
    resourceReads: 0,
    hits: 0,
    misses: 0,
    coalesced: 0,
    failures: 0,
    backoffSkips: 0,
  };

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  count(name: keyof OpCache['counts']): void {
    this.#counts[name] = Math.min(Number.MAX_SAFE_INTEGER, this.#counts[name] + 1);
  }

  get counts() {
    return { ...this.#counts };
  }
  nextRequestOrder(): number {
    if (this.#requestOrder === Number.MAX_SAFE_INTEGER) {
      this.flush();
      this.#requestOrder = 0;
    }
    return ++this.#requestOrder;
  }

  generation(agentId: string): object {
    let generation = this.#generations.get(agentId);
    if (!generation) {
      if (this.#generations.size >= 1024) this.flush(this.#generations.keys().next().value!);
      generation = {};
      this.#generations.set(agentId, generation);
    }
    return generation;
  }

  configureContext(value: unknown): void {
    const signature = opDigest(value);
    if (this.#configuration !== undefined && this.#configuration !== signature) this.flush();
    this.#configuration = signature;
  }

  configure(value: unknown): OpCachePolicy {
    let policy;
    try {
      policy = resolveOpCachePolicy(value);
    } catch (error) {
      this.flush();
      throw error;
    }
    if (JSON.stringify(policy) !== JSON.stringify(this.#policy)) {
      this.flush();
      this.#policy = policy;
    }
    return policy;
  }

  flush(agentId?: string) {
    if (agentId === undefined) this.#generations.clear();
    else this.#generations.delete(agentId);
    let entries = 0;
    let clients = 0;
    let pending = 0;
    let values = 0;
    for (const [key, entry] of this.#entries) {
      if (agentId !== undefined && entry.agentId !== agentId) continue;
      entries += 1;
      clients += Number(!!entry.client);
      pending += Number(!!entry.pending);
      values += Number(!!entry.snapshot);
      this.#entries.delete(key);
    }
    return { entries, clients, pending, values };
  }

  blocked(token: string): boolean {
    const now = this.#now();
    const blocked =
      Math.max(this.#backoff.get(opDigest(token))?.retryAt ?? 0, this.#overflowRetryAt) > now;
    if (blocked) this.count('backoffSkips');
    return blocked;
  }

  failure(token: string, error: unknown): void {
    this.count('failures');
    const now = this.#now();
    const key = opDigest(token);
    for (const [id, entry] of this.#entries) {
      if (entry.credentialFingerprint === key) this.#entries.delete(id);
    }
    const failures = Math.min(8, (this.#backoff.get(key)?.failures ?? 0) + 1);
    const quota = error instanceof Error && error.constructor.name === 'RateLimitExceededError';
    const retryAt = Math.max(
      this.#backoff.get(key)?.retryAt ?? 0,
      now + (quota ? 3_600_000 : Math.min(3_600_000, 30_000 * 2 ** (failures - 1))),
    );
    for (const [id, state] of this.#backoff) {
      if (state.retryAt <= now && id !== key) this.#backoff.delete(id);
    }
    if (this.#backoff.has(key) || this.#backoff.size < 1024) {
      this.#backoff.set(key, { failures, retryAt });
    } else {
      // Saturation fails closed without evicting an active provider backoff.
      this.#overflowRetryAt = Math.max(this.#overflowRetryAt, retryAt);
    }
  }

  status() {
    const now = this.#now();
    return {
      policy: { ...this.#policy },
      process: { pid: process.pid, scope: 'process-local' },
      counts: this.counts,
      entries: [...this.#entries.values()].map((entry) => ({
        agentId: entry.agentId,
        client: !!entry.client,
        pending: !!entry.pending,
        cached: !!entry.snapshot,
        ageMs: entry.retrievedAt === undefined ? null : Math.max(0, now - entry.retrievedAt),
        expiresInMs: entry.expiresAt === undefined ? null : Math.max(0, entry.expiresAt - now),
        expired: entry.expiresAt !== undefined && entry.expiresAt <= now,
      })),
      backoff: {
        active: [...this.#backoff.values()].filter(({ retryAt }) => retryAt > now).length,
        retryInMs: Math.max(
          0,
          this.#overflowRetryAt - now,
          ...[...this.#backoff.values()].map(({ retryAt }) => retryAt - now),
        ),
      },
    };
  }

  async load(input: {
    agentId: string;
    workspaceDir: string;
    fingerprint: string;
    token: string;
    generation: object;
    requestOrder: number;
    retain: boolean;
    fresh: boolean;
    createClient(): Promise<OpEnvironmentClient>;
    fetch(client: OpEnvironmentClient): Promise<OpEnvironmentLoadResult>;
  }): Promise<OpEnvironmentLoadResult> {
    if (input.generation !== this.#generations.get(input.agentId)) return invalidatedOpLoad();
    const policy: OpCachePolicy =
      input.agentId === '' ? { mode: 'off', maxEntries: 1 } : this.#policy;
    const key = opDigest([input.agentId, input.workspaceDir]);
    let entry = this.#entries.get(key);
    if (entry?.fingerprint !== input.fingerprint) {
      if (entry && entry.requestOrder > input.requestOrder) return invalidatedOpLoad();
      this.#entries.delete(key);
      entry = undefined;
    }
    if (!entry || policy.mode === 'off') {
      entry = {
        agentId: input.agentId,
        fingerprint: input.fingerprint,
        requestOrder: input.requestOrder,
        credentialFingerprint: opDigest(input.token),
      };
      if (policy.mode !== 'off') {
        while (this.#entries.size >= policy.maxEntries) {
          const oldest = this.#entries.values().next().value!;
          if (oldest.agentId === input.agentId && oldest.requestOrder > input.requestOrder)
            return invalidatedOpLoad();
          this.flush(oldest.agentId);
          if (oldest.agentId === input.agentId) input.generation = this.generation(input.agentId);
        }
        if (input.generation !== this.#generations.get(input.agentId)) return invalidatedOpLoad();
        this.#entries.set(key, entry);
      }
    }
    const selected = entry;
    selected.requestOrder = Math.max(selected.requestOrder, input.requestOrder);
    if (
      selected.snapshot &&
      (selected.expiresAt === undefined || selected.expiresAt > this.#now()) &&
      !input.fresh
    ) {
      this.count('hits');
      return selected.snapshot;
    }
    if (selected.pending) {
      this.count('coalesced');
      return selected.pending;
    }
    delete selected.snapshot;
    delete selected.retrievedAt;
    delete selected.expiresAt;
    this.count('misses');
    if (this.blocked(input.token))
      return {
        status: 'invalid',
        diagnostics: [
          {
            severity: 'error',
            code: 'op-provider-backoff',
            fieldPath: '/environment',
            message: 'OP provider backoff is active; no provider request was made.',
          },
        ],
      };
    const current = () =>
      input.generation === this.#generations.get(input.agentId) &&
      (policy.mode === 'off' || this.#entries.get(key) === selected);
    const pending = (async () => {
      let result: OpEnvironmentLoadResult;
      try {
        selected.client ??= (async () => {
          this.count('clientCreations');
          return input.createClient();
        })();
        result = await input.fetch(await selected.client);
      } catch (error) {
        this.failure(input.token, error);
        result = {
          status: 'invalid',
          diagnostics: [
            {
              severity: 'error',
              code: 'op-authentication-failed',
              fieldPath: '/environment',
              message: 'Agent System could not authenticate the OP SDK client.',
            },
          ],
        };
      }
      if (result.status === 'invalid') {
        if (this.#entries.get(key) === selected) this.#entries.delete(key);
        return result;
      }
      if (!current()) return invalidatedOpLoad();
      if ((this.#backoff.get(opDigest(input.token))?.retryAt ?? 0) <= this.#now())
        this.#backoff.delete(opDigest(input.token));
      const snapshot = freezeSnapshot(result);
      if (policy.mode !== 'off' && input.retain && !input.fresh) {
        selected.snapshot = snapshot;
        selected.retrievedAt = this.#now();
        if (policy.mode === 'timed')
          selected.expiresAt = Math.min(
            Number.MAX_SAFE_INTEGER,
            selected.retrievedAt + Math.max(1, policy.durationSeconds * 1000),
          );
      }
      return snapshot;
    })();
    selected.pending = pending;
    try {
      return await pending;
    } finally {
      delete selected.pending;
    }
  }
}
