import assert from 'node:assert/strict';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import registerOpCache from '../core/register-op-cache.ts';
import OpEnvironmentService from '../environment/op-service.ts';
import processOpCache from '../environment/op-process-cache.ts';
import credentialsCache from '../cli/credentials-cache.ts';

function fixture(sharedScope?: string) {
  type Handler = Parameters<OpenClawPluginApi['registerGatewayMethod']>[1];
  const handlers = new Map<string, Handler>();
  const scopes = new Map<string, unknown>();
  let lifecycle!: Parameters<OpenClawPluginApi['registerService']>[0];
  let reads = 0;
  const service = new OpEnvironmentService({
    ...(sharedScope
      ? { cache: processOpCache({ packageDir: '/plugin', stateDir: sharedScope }) }
      : {}),
    integrationVersion: 'test',
    credentialService: {
      async resolveServiceAccountToken() {
        return {
          status: 'resolved',
          token: 'private-token',
          source: { id: 'file', type: 'store' },
        };
      },
    },
    async createClient() {
      return {
        async resolveSecret() {
          reads += 1;
          return 'private-value';
        },
        async getVariables() {
          reads += 1;
          return { variables: [] };
        },
      };
    },
  });
  registerOpCache(
    {
      registerGatewayMethod(method, handler, options) {
        handlers.set(method, handler);
        scopes.set(method, options?.scope);
      },
      registerService(value) {
        lifecycle = value;
      },
    },
    service,
  );
  return {
    service,
    reads: () => reads,
    scopes,
    lifecycle,
    async request(
      action: string,
      params = {},
      access: { role?: string; scopes?: string[]; invalidated?: boolean } = {
        role: 'operator',
        scopes: ['operator.admin'],
      },
    ) {
      let response: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
      await handlers.get(`agent-system.op-cache.${action}`)!({
        params,
        client: {
          connect: { role: access.role, scopes: access.scopes },
          invalidated: access.invalidated,
        },
        respond(ok: boolean, payload?: unknown, error?: unknown) {
          response = { ok, payload, error };
        },
      } as never);
      assert.ok(response);
      return response;
    },
    warm: (agentId = 'data') =>
      service.load(
        agentId,
        {
          environmentIds: ['private-id'],
          secrets: [{ name: 'KEY', reference: 'op://private/item/key' }],
        },
        { workspaceDir: '/workspace' },
      ),
  };
}

describe('core/op-cache-gateway', () => {
  it('should inspect and invalidate values loaded through another plugin registration', async () => {
    const gateway = fixture('/test/gateway-shared-cache');
    const tools = fixture('/test/gateway-shared-cache');
    await tools.warm();
    await tools.warm('other');
    const warmed = await gateway.request('status');
    assert.equal(warmed.ok, true);
    assert.equal(gateway.service.status().entries.filter((entry) => entry.cached).length, 2);
    await gateway.warm();
    assert.equal(gateway.reads(), 0);
    assert.equal(tools.reads(), 4);
    assert.equal(gateway.service.status().counts.hits, 1);

    const flushed = await gateway.request('flush', { agentId: 'data' });
    assert.equal(flushed.ok, true);
    assert.deepEqual(
      tools.service.status().entries.map((entry) => entry.agentId),
      ['other'],
    );
    assert.equal(tools.reads(), 4);
    await tools.warm();
    assert.equal(tools.reads(), 6);

    // A late registration must join the same owner, not start another empty cache.
    const late = fixture('/test/gateway-shared-cache');
    await late.warm();
    assert.equal(late.reads(), 0);
    await gateway.lifecycle.stop?.({} as never);
    assert.equal(late.service.status().entries.length, 0);
  });

  it('should expose gateway status and flush without fetching or disclosing values', async () => {
    const f = fixture();
    await f.warm();
    const status = await f.request('status');
    assert.equal(status.ok, true);
    assert.equal(f.reads(), 2);
    const text = JSON.stringify(status);
    assert.equal(text.includes('private'), false);
    assert.match(text, /gateway/);
    const flushed = await f.request('flush', { agentId: 'data' });
    assert.equal(flushed.ok, true);
    assert.deepEqual((flushed.payload as { invalidated: unknown }).invalidated, {
      entries: 1,
      clients: 1,
      pending: 0,
      values: 1,
    });
    assert.equal(f.reads(), 2);
    assert.equal(f.service.status().entries.length, 0);
    assert.equal((await f.request('flush')).ok, true);
    assert.equal(f.reads(), 2);
  });

  it('should require operator scope and reject revoked, node and malformed requests', async () => {
    const f = fixture();
    await f.warm();
    assert.equal(f.scopes.get('agent-system.op-cache.status'), 'operator.read');
    assert.equal(f.scopes.get('agent-system.op-cache.flush'), 'operator.admin');
    for (const access of [
      { role: 'operator', scopes: ['operator.read'] },
      { role: 'node', scopes: ['operator.admin'] },
      { role: 'operator', scopes: ['operator.admin'], invalidated: true },
      {},
    ]) {
      assert.equal((await f.request('flush', {}, access)).ok, false);
    }
    for (const params of [{ token: 'private' }, { agentId: 3 }, { agentId: '../other' }]) {
      assert.equal((await f.request('flush', params)).ok, false);
    }
    assert.equal(
      (await f.request('status', {}, { role: 'operator', scopes: ['operator.read'] })).ok,
      true,
    );
    assert.equal(f.service.status().entries.length, 1);
    assert.equal(f.reads(), 2);
  });

  it('should invalidate retained generations on gateway service shutdown or configuration reload', async () => {
    const f = fixture();
    await f.warm();
    assert.deepEqual(f.lifecycle.reload?.configPrefixes, [
      'agents',
      'plugins.entries.agent-system.config',
    ]);
    await f.lifecycle.stop?.({} as never);
    assert.equal(f.service.status().entries.length, 0);
    assert.equal(f.reads(), 2);
  });

  it('should report unreachable gateway honestly and never fall back to local success', async () => {
    let code = 0;
    const output: string[] = [];
    const errors: string[] = [];
    await credentialsCache({
      action: 'flush',
      agentId: 'data',
      request: async () => {
        throw new Error('private-transport-error');
      },
      output: {
        writeStdout: (line: string) => {
          output.push(line);
        },
        writeStderr: (line: string) => {
          errors.push(line);
        },
      },
      setExitCode(value) {
        code = value;
      },
    });
    assert.equal(code, 1);
    assert.equal(output.length, 0);
    assert.match(errors.join(''), /not confirmed/);
    assert.equal(errors.join('').includes('private-transport-error'), false);
  });
});
