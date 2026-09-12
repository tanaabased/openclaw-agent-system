import assert from 'node:assert/strict';

import OpEnvironmentService from '../environment/op-service.ts';
import resolveOpCachePolicy from '../environment/op-cache-policy.ts';

const requirements = {
  environmentIds: ['private-environment'],
  secrets: [{ name: 'KEY', reference: 'op://private/item/key' }],
};

function fixture() {
  let now = 0;
  let token = 'private-token';
  let source = 'file';
  let policy: unknown;
  let failure: Error | undefined;
  let delay: (() => Promise<void>) | undefined;
  let credentials = 0;
  let clients = 0;
  let reads = 0;
  const service = new OpEnvironmentService({
    integrationVersion: 'test',
    now: () => now,
    readCachePolicy: () => policy,
    credentialService: {
      async resolveServiceAccountToken() {
        credentials += 1;
        return { status: 'resolved', token, source: { id: source, type: 'store' } };
      },
    },
    async createClient() {
      clients += 1;
      return {
        async resolveSecret() {
          reads += 1;
          return `private-value-${token}`;
        },
        async getVariables() {
          reads += 1;
          await delay?.();
          if (failure) throw failure;
          return { variables: [{ name: 'ENV', value: `private-env-${reads}`, masked: true }] };
        },
      };
    },
  });
  return {
    service,
    counts: () => ({ clients, reads, credentials }),
    time(value: number) {
      now = value;
    },
    policy(value: unknown) {
      policy = value;
    },
    token(value: string) {
      token = value;
    },
    source(value: string) {
      source = value;
    },
    fail(error?: Error) {
      failure = error;
    },
    delay(value?: () => Promise<void>) {
      delay = value;
    },
    load: (agentId = 'data', workspaceDir = '/workspace') =>
      service.load(agentId, requirements, { workspaceDir }),
  };
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ready,
    release,
    delay: async () => {
      entered();
      await pending;
    },
  };
}

describe('environment/op-cache', () => {
  it('should isolate malformed environment data without provider backoff or partial retention', async () => {
    for (const variables of [
      [{ name: 'INVALID-NAME', value: 'private', masked: true }],
      [
        { name: 'DUPLICATE', value: 'private-one', masked: true },
        { name: 'DUPLICATE', value: 'private-two', masked: true },
      ],
    ]) {
      let repaired = false;
      const service = new OpEnvironmentService({
        integrationVersion: 'test',
        credentialService: {
          async resolveServiceAccountToken() {
            return { status: 'resolved', token: 'shared', source: { id: 'file', type: 'store' } };
          },
        },
        async createClient() {
          return {
            async resolveSecret() {
              return 'private-secret';
            },
            async getVariables(id) {
              return { variables: id === 'broken' && !repaired ? variables : [] };
            },
          };
        },
      });
      const load = (agentId: string) =>
        service.load(agentId, {
          ...requirements,
          environmentIds: [agentId],
        });
      const healthy = await load('healthy');
      assert.equal(healthy.status, 'loaded');
      const failed = await load('broken');
      assert.equal(failed.status, 'invalid');
      if (failed.status === 'invalid') {
        assert.match(failed.diagnostics[0]!.code, /^op-variable-(invalid|duplicate)$/);
      }
      assert.deepEqual(
        service.status().entries.map(({ agentId }) => agentId),
        ['healthy'],
      );
      assert.equal(service.status().backoff.retryInMs, 0);
      assert.equal(service.status().counts.failures, 1);
      const reads = service.status().counts.resourceReads;
      assert.equal(await load('healthy'), healthy);
      assert.equal(service.status().counts.resourceReads, reads);
      repaired = true;
      assert.equal((await load('broken')).status, 'loaded');
      assert.equal(service.status().counts.resourceReads, reads + 2);
    }
  });

  it('should preserve healthy snapshots during provider transport backoff but block new fetches', async () => {
    const f = fixture();
    const healthy = await f.load('healthy');
    f.fail(new Error('private-network-timeout'));
    assert.equal((await f.load('other')).status, 'invalid');
    assert.equal(await f.load('healthy'), healthy);
    assert.equal(f.counts().reads, 4);
    const blocked = await f.load('third');
    assert.equal(blocked.status, 'invalid');
    if (blocked.status === 'invalid')
      assert.equal(blocked.diagnostics[0]!.code, 'op-provider-backoff');
    assert.equal(f.counts().reads, 4);
    f.service.flush();
    assert.equal(f.service.status().backoff.retryInMs, 30_000);
    assert.equal((await f.load('healthy')).status, 'invalid');
    assert.equal(f.counts().reads, 4);
  });

  it('should invalidate shared credentials on confirmed sdk authentication rejection', async () => {
    class AuthExpiredError extends Error {}
    const f = fixture();
    await f.load('healthy');
    f.fail(new AuthExpiredError('private-rejection'));
    assert.equal((await f.load('other')).status, 'invalid');
    assert.equal(f.service.status().entries.length, 0);
    assert.equal((await f.load('healthy')).status, 'invalid');
    assert.equal(f.counts().reads, 4);
    assert.equal(f.service.status().backoff.retryInMs, 30_000);
  });

  it('should validate explicit modes, finite positive durations and bounded entries', () => {
    assert.deepEqual(resolveOpCachePolicy(undefined), {
      mode: 'timed',
      durationSeconds: 300,
      maxEntries: 128,
    });
    for (const durationSeconds of [0.001, 3600, 18000, 43200]) {
      assert.equal(resolveOpCachePolicy({ durationSeconds }).mode, 'timed');
    }
    for (const value of [
      null,
      [],
      { mode: 'forever' },
      { durationSeconds: 0 },
      { durationSeconds: -1 },
      { durationSeconds: Infinity },
      { durationSeconds: NaN },
      { durationSeconds: Number.MAX_VALUE },
      { durationSeconds: '300' },
      { maxEntries: 0 },
      { maxEntries: 1025 },
      { maxEntries: 1.5 },
      { mode: 'process-lifetime', durationSeconds: 300 },
      { unexpected: true },
    ]) {
      assert.throws(() => resolveOpCachePolicy(value));
    }
  });

  it('should reproduce disabled costs and measure sequential and concurrent sdk savings', async () => {
    for (const concurrent of [false, true]) {
      for (const mode of ['off', 'timed', 'process-lifetime']) {
        const f = fixture();
        f.policy({ mode });
        if (concurrent) await Promise.all(Array.from({ length: 40 }, () => f.load()));
        else for (let index = 0; index < 40; index += 1) await f.load();
        assert.deepEqual(f.counts(), {
          credentials: 40,
          clients: mode === 'off' ? 40 : 1,
          reads: mode === 'off' ? 80 : 2,
        });
        const counts = f.service.status().counts;
        assert.equal(counts.clientCreations, f.counts().clients);
        assert.equal(counts.resourceReads, f.counts().reads);
        assert.equal(counts.hits, mode !== 'off' && !concurrent ? 39 : 0);
        assert.equal(counts.coalesced, mode !== 'off' && concurrent ? 39 : 0);
      }
    }
  });

  it('should retain the per-process cost of short-lived cli operations', async () => {
    let clients = 0;
    let reads = 0;
    for (let index = 0; index < 40; index += 1) {
      const f = fixture();
      await f.load();
      clients += f.counts().clients;
      reads += f.counts().reads;
    }
    assert.deepEqual({ clients, reads }, { clients: 40, reads: 80 });
  });

  it('should expire lazily from successful retrieval without sliding on hits', async () => {
    const f = fixture();
    const g = gate();
    f.delay(g.delay);
    const first = f.load();
    await g.ready;
    f.time(100_000);
    g.release();
    await first;
    f.time(399_999);
    await f.load();
    assert.equal(f.counts().reads, 2);
    f.time(400_000);
    assert.equal(f.counts().reads, 2);
    assert.equal(f.service.status().entries[0]?.expired, true);
    await f.load();
    assert.equal(f.counts().reads, 4);
    assert.equal(f.counts().clients, 1);
  });

  it('should support long durations and explicit process-lifetime retention', async () => {
    for (const durationSeconds of [3600, 18000, 43200]) {
      const f = fixture();
      f.policy({ mode: 'timed', durationSeconds });
      await f.load();
      f.time(durationSeconds * 1000 - 1);
      await f.load();
      assert.equal(f.counts().reads, 2);
      f.time(durationSeconds * 1000);
      await f.load();
      assert.equal(f.counts().reads, 4);
    }
    const f = fixture();
    f.policy({ mode: 'process-lifetime' });
    await f.load();
    f.time(10 ** 12);
    await f.load();
    assert.equal(f.counts().reads, 2);
    assert.equal(f.service.status().entries[0]?.expiresInMs, null);
  });

  it('should isolate agents, workspaces, credential sources, rotations and declarations', async () => {
    const f = fixture();
    await f.load();
    await f.load('other');
    await f.load('data', '/other');
    f.token('rotated');
    await f.load();
    f.source('native');
    await f.load();
    await f.service.load(
      'data',
      { ...requirements, secrets: [{ name: 'OTHER', reference: 'op://other/item/key' }] },
      { workspaceDir: '/workspace' },
    );
    assert.equal(f.counts().reads, 12);
    const serialized = JSON.stringify(f.service.status());
    for (const value of ['private-', 'rotated', 'native', '/workspace', 'op://'])
      assert.equal(serialized.includes(value), false);
  });

  it('should invalidate policy changes before resolving any credentials', async () => {
    const f = fixture();
    await f.load();
    f.policy({ mode: 'off' });
    await f.load();
    assert.equal(f.counts().reads, 4);
    f.policy({ durationSeconds: -1 });
    assert.equal((await f.load()).status, 'invalid');
    assert.equal(f.counts().credentials, 2);
  });

  it('should deduplicate resources while preserving ordered source precedence', async () => {
    const f = fixture();
    const loaded = await f.service.load('data', {
      environmentIds: ['same', 'same'],
      secrets: [
        { name: 'A', reference: 'op://a/b/c' },
        { name: 'B', reference: 'op://a/b/c' },
      ],
    });
    assert.equal(f.counts().reads, 2);
    assert.equal(loaded.status, 'loaded');
    if (loaded.status !== 'loaded') return;
    assert.equal(loaded.set.values.A, loaded.set.values.B);
    assert.deepEqual(
      loaded.sources.map(({ source }) => source),
      ['environment.op[0]', 'environment.op[1]'],
    );
    assert.equal(Reflect.set(loaded.set.values, 'A', 'mutated'), false);
    assert.equal(Reflect.set(loaded.sources[0]!.values, 'ENV', 'mutated'), false);
  });

  it('should bypass retention for otp aliases, encoded attributes and unknown transforms', async () => {
    for (const query of ['attribute=otp', 'attr=totp', '%61ttribute=%6ftp', 'future=dynamic']) {
      const f = fixture();
      const input = {
        environmentIds: [],
        secrets: [{ name: 'OTP', reference: `op://a/b/c?${query}` }],
      };
      await f.service.load('data', input);
      await f.service.load('data', input);
      assert.equal(f.counts().reads, 2);
      assert.equal(f.service.status().entries[0]?.cached, false);
    }
  });

  it('should not let one caller cancellation abort a shared load', async () => {
    const f = fixture();
    const g = gate();
    f.delay(g.delay);
    const controller = new AbortController();
    const cancelled = f.service.load('data', requirements, {
      workspaceDir: '/workspace',
      signal: controller.signal,
    });
    await g.ready;
    const retained = f.load();
    controller.abort();
    assert.equal((await cancelled).status, 'invalid');
    g.release();
    assert.equal((await retained).status, 'loaded');
    assert.equal(f.counts().reads, 2);
    await f.load();
    assert.equal(f.counts().reads, 2);
  });

  it('should reject old in-flight results after flush or a policy generation change', async () => {
    for (const flush of [true, false]) {
      const f = fixture();
      const g = gate();
      f.delay(g.delay);
      const old = f.load();
      await g.ready;
      if (flush) assert.equal(f.service.flush('data').pending, 1);
      else {
        f.policy({ mode: 'process-lifetime' });
        f.service.status();
      }
      g.release();
      assert.equal((await old).status, 'invalid');
      assert.equal(f.service.status().entries.length, 0);
      assert.equal((await f.load()).status, 'loaded');
      assert.equal(f.counts().reads, 4);
    }
  });

  it('should reject a slow old credential lookup after a newer rotation is observed', async () => {
    const g = gate();
    let resolutions = 0;
    let reads = 0;
    const service = new OpEnvironmentService({
      integrationVersion: 'test',
      credentialService: {
        async resolveServiceAccountToken() {
          const old = resolutions++ === 0;
          if (old) await g.delay();
          return {
            status: 'resolved',
            token: old ? 'old' : 'new',
            source: { id: 'file', type: 'store' },
          };
        },
      },
      async createClient(token) {
        return {
          async resolveSecret() {
            reads += 1;
            return token;
          },
          async getVariables() {
            reads += 1;
            return { variables: [] };
          },
        };
      },
    });
    const pending = service.load('data', requirements);
    await g.ready;
    const current = await service.load('data', requirements);
    assert.equal(current.status, 'loaded');
    g.release();
    assert.equal((await pending).status, 'invalid');
    await service.load('data', requirements);
    assert.equal(reads, 2);
  });

  it('should preserve backoff when another same-credential request completes after a quota failure', async () => {
    class RateLimitExceededError extends Error {}
    const g = gate();
    let clients = 0;
    const service = new OpEnvironmentService({
      integrationVersion: 'test',
      now: () => 0,
      credentialService: {
        async resolveServiceAccountToken() {
          return { status: 'resolved', token: 'shared', source: { id: 'file', type: 'store' } };
        },
      },
      async createClient() {
        const delayed = clients++ === 0;
        return {
          async resolveSecret() {
            return 'value';
          },
          async getVariables() {
            if (delayed) {
              await g.delay();
              return { variables: [] };
            }
            throw new RateLimitExceededError('private-quota');
          },
        };
      },
    });
    const pending = service.load('one', requirements);
    await g.ready;
    assert.equal((await service.load('two', requirements)).status, 'invalid');
    g.release();
    assert.equal((await pending).status, 'invalid');
    assert.equal(service.status().backoff.retryInMs, 3_600_000);
    assert.equal(service.status().entries.length, 0);
  });

  it('should prevent a credential lookup started before flush from repopulating the cache', async () => {
    const g = gate();
    let reads = 0;
    const service = new OpEnvironmentService({
      integrationVersion: 'test',
      credentialService: {
        async resolveServiceAccountToken() {
          await g.delay();
          return { status: 'resolved', token: 'private', source: { id: 'file', type: 'store' } };
        },
      },
      async createClient() {
        reads += 1;
        throw new Error('not expected');
      },
    });
    const pending = service.load('data', requirements);
    await g.ready;
    service.flush();
    g.release();
    assert.equal((await pending).status, 'invalid');
    assert.equal(reads, 0);
  });

  it('should never retain partial failures or serve expired values after refresh failure', async () => {
    const f = fixture();
    await f.load();
    f.time(300_000);
    f.fail(new Error('private-provider-error'));
    assert.equal((await f.load()).status, 'invalid');
    assert.equal(f.service.status().entries.length, 0);
    assert.equal((await f.load()).status, 'invalid');
    assert.equal(f.counts().reads, 4);
    f.time(330_000);
    f.fail();
    await f.load();
    assert.equal(f.counts().reads, 6);
  });

  it('should preserve shared quota backoff across consumers and flush', async () => {
    class RateLimitExceededError extends Error {}
    const f = fixture();
    f.fail(new RateLimitExceededError('private-quota'));
    await f.load();
    const before = f.counts();
    f.service.flush();
    f.service.status();
    await f.load('other');
    assert.deepEqual(f.counts(), { ...before, credentials: before.credentials + 1 });
    assert.equal(f.service.status().counts.backoffSkips, 1);
    assert.equal(f.service.status().backoff.retryInMs, 3_600_000);
    assert.equal(JSON.stringify(f.service.status()).includes('private-quota'), false);
  });

  it('should bound retained clients, pending entries and snapshots', async () => {
    const f = fixture();
    f.policy({ maxEntries: 2 });
    await f.load('one');
    await f.load('two');
    await f.load('three');
    assert.equal(f.service.status().entries.length, 2);
    await f.load('one');
    assert.equal(f.counts().reads, 8);
    assert.equal(f.service.status().entries.length, 2);
  });
});
