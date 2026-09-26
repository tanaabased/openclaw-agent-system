import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentSystemToolRuntime from '../api/runtime.ts';
import type { AgentSystemCliRunRequest } from '../api/types.ts';
import type { AgentManifest } from '../manifest/types.ts';
import GoogleClient, {
  assertGoogleIdentity,
  assertGoogleResult,
  googleFailureStatus,
} from '../tools/google/client.ts';
import GoogleStore from '../tools/google/store.ts';
import createGoogleTool from '../tools/google/tool.ts';
import {
  fakeGoogle,
  googleConfiguration,
  googleValues,
  material,
  result,
} from './google-test-fixture.ts';

describe('google managed runtime', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'google-runtime-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function fixture(
    options: {
      missing?: boolean;
      deny?: boolean;
      environmentAccount?: boolean;
      mismatch?: boolean;
      echoSecret?: boolean;
    } = {},
  ) {
    const requests: AgentSystemCliRunRequest[] = [];
    const events: string[] = [];
    const logs: string[] = [];
    const runner = fakeGoogle(requests);
    const store = new GoogleStore(
      join(root, 'private'),
      new GoogleClient(runner, { PATH: '/usr/bin' }),
    );
    await store.reconcile('one', googleConfiguration.account, material(), root);
    requests.length = 0;
    const tool = createGoogleTool(store);
    const manifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'one' },
      google: {
        ...googleConfiguration,
        account: options.environmentAccount
          ? { fromEnvironment: 'ACCOUNT' }
          : googleConfiguration.account,
      },
    };
    const loaded = {
      status: 'loaded' as const,
      scope: { agentId: 'one', workspaceDir: root },
      path: join(root, 'agent.yaml'),
      digest: 'digest',
      manifest,
      diagnostics: [],
      validationChecks: [],
    };
    const runtime = new AgentSystemToolRuntime({
      baseEnvironment: {
        PATH: '/usr/bin',
        HOME: '/host',
        GOG_ACCESS_TOKEN: 'host-token',
        GOG_HOME: '/host',
      },
      resolveExecutable: async () => {
        events.push('executable');
        if (options.missing) throw new Error();
        return '/usr/bin/gog';
      },
      authorize: async () => {
        events.push('authorization');
        return options.deny ? { status: 'denied', reason: 'denied' } : { status: 'allowed' };
      },
      manifestService: {
        async loadForAgentId() {
          return loaded;
        },
        async loadForCommandDirectory() {
          return loaded;
        },
      },
      environmentService: {
        async loadForAgentId() {
          events.push('credentials');
          return {
            ...loaded,
            environment: { values: { ...googleValues, ACCOUNT: 'one@example.com' }, variables: [] },
          };
        },
      },
      logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
      runCli: async (request) => {
        if (options.mismatch && request.argv.includes('oauth2.userinfo.get'))
          return result(JSON.stringify({ email: 'other@example.com', verified_email: true }));
        if (options.echoSecret && request.argv.includes('gmail'))
          return result('refresh-secret client-secret keyring-secret');
        return runner(request);
      },
    });
    return { tool, runtime, events, requests, logs };
  }
  it('should execute literal and environment accounts identically with isolated credentials and audit', async () => {
    for (const environmentAccount of [false, true]) {
      const f = await fixture({ environmentAccount });
      const executed = await f.tool.invoke(f.runtime, ['gmail', 'search', 'q'], {
        source: 'command',
        agentId: 'one',
        workspaceDir: root,
      });
      assert.equal(executed.operation.action, 'gmail.search');
      const command = f.requests.find((request) => request.argv.includes('gmail'))!;
      assert.ok(command.argv.includes('--account=one@example.com'));
      assert.ok(command.argv.includes('--no-input'));
      assert.equal(command.environment.GOG_ACCESS_TOKEN, undefined);
      assert.notEqual(command.environment.HOME, '/host');
      assert.deepEqual(f.events.slice(0, 3), ['authorization', 'executable', 'credentials']);
      assert.ok(f.logs.some((log) => log.includes('tool_call_completed')));
    }
  });
  it('should reject overrides, denied requests and missing executables before credential resolution', async () => {
    const invalid = await fixture();
    await assert.rejects(
      invalid.tool.invoke(invalid.runtime, ['gmail', 'search', '--client=host'], {
        source: 'command',
        agentId: 'one',
        workspaceDir: root,
      }),
      { code: 'invalid_arguments' },
    );
    assert.deepEqual(invalid.events, []);
    for (const options of [{ deny: true }, { missing: true }]) {
      const f = await fixture(options);
      await assert.rejects(
        f.tool.invoke(f.runtime, ['gmail', 'search', 'q'], {
          source: 'command',
          agentId: 'one',
          workspaceDir: root,
        }),
        { code: options.deny ? 'approval_denied' : 'tool_unavailable' },
      );
      assert.ok(!f.events.includes('credentials'));
      assert.deepEqual(f.requests, []);
    }
  });
  it('should stop on provider identity mismatch before running the requested data command', async () => {
    const f = await fixture({ mismatch: true });
    await assert.rejects(
      f.tool.invoke(f.runtime, ['gmail', 'search', 'q'], {
        source: 'command',
        agentId: 'one',
        workspaceDir: root,
      }),
      { code: 'tool_identity_mismatch' },
    );
    assert.ok(!f.requests.some((request) => request.argv.includes('gmail')));
    assert.ok(f.logs.some((log) => log.includes('tool_call_failed')));
  });
  it('should redact credential components and allow provider-authorized writes', async () => {
    const f = await fixture({ echoSecret: true });
    const executed = await f.tool.invoke(
      f.runtime,
      ['gmail', 'send', '--to=one@example.com', '--subject=test', '--body=test'],
      { source: 'command', agentId: 'one', workspaceDir: root },
    );
    assert.equal(executed.operation.risk, 'write');
    assert.ok(!JSON.stringify(executed).includes('refresh-secret'));
    assert.ok(!JSON.stringify(executed).includes('client-secret'));
    assert.ok(!JSON.stringify(executed).includes('keyring-secret'));
  });
  it('should distinguish revoked grants, insufficient scopes, provider permission and malformed identity', () => {
    assert.throws(() => assertGoogleResult(result('', 4, 'invalid_grant')), {
      credentialRejected: true,
    });
    assert.equal(
      googleFailureStatus(
        result('', 4, 'OAuth grant for one@example.com is missing required gmail scope: x'),
      ),
      'insufficient-scope',
    );
    assert.throws(() => assertGoogleResult(result('', 6)), /permissions/u);
    assert.throws(() => assertGoogleIdentity(result('{}'), 'one@example.com'), {
      code: 'tool_identity_mismatch',
    });
    assert.throws(
      () => assertGoogleIdentity(result('{'), 'one@example.com'),
      /invalid authenticated identity/u,
    );
    assert.throws(
      () => assertGoogleIdentity(result('null'), 'one@example.com'),
      /invalid authenticated identity/u,
    );
    assert.throws(
      () =>
        assertGoogleIdentity(
          result('{"email":"one@example.com","verified_email":false}'),
          'one@example.com',
        ),
      { code: 'tool_identity_mismatch' },
    );
  });
});
