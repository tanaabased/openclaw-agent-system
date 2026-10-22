import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
} from '@openclaw/gateway-client';

import AgentInstallService from '../agent/install-service.ts';
import createSessionDispatchLifecycle from '../agent/session-dispatch-lifecycle.ts';
import sessionDispatchRequirements, {
  sessionDispatchScopes,
} from '../agent/session-dispatch-requirements.ts';
import confirmSessionDispatch from '../cli/session-dispatch-consent.ts';
import SessionDispatchCredential, {
  type DispatchCredential,
  type DispatchCredentialDependencies,
} from '../credentials/session-dispatch.ts';
import type { CredentialStore } from '../credentials/types.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { intakeFixture } from './github-intake-fixture.ts';

function manifest(): AgentManifest {
  return {
    schemaVersion: 1,
    agent: { id: 'receiver' },
    github: {
      username: 'receiver',
      notifications: { ...intakeFixture().policy, runtimes: ['openclaw'] },
    },
  };
}

function fixture() {
  let value: string | undefined;
  let paired = false;
  let requestId: string | undefined;
  let pending = false;
  let unavailable = false;
  let failedWrite = false;
  let now = 0;
  const calls: string[] = [];
  const store: CredentialStore = {
    id: 'fixture',
    async read() {
      return value === undefined ? { status: 'missing' } : { status: 'found', value };
    },
    async write(_key, next) {
      calls.push('store');
      if (failedWrite) return { status: 'unavailable', code: 'fixture', message: 'fixture' };
      value = next;
      return { status: 'stored' };
    },
    async remove() {
      calls.push('remove');
      value = undefined;
      return { status: 'removed' };
    },
  };
  const dependencies: DispatchCredentialDependencies = {
    key: { agentId: 'gateway-test', credentialId: 'session-dispatch' },
    store,
    lock: async (operation) => operation(() => {}),
    pairing: async () => ({ paired, usable: paired, requestId }),
    async issue(guard) {
      guard();
      calls.push('issue');
      return { token: 'fixture-bootstrap', expiresAtMs: now + 1000 };
    },
    async revoke() {
      calls.push('revoke');
    },
    async connect(record, bootstrap) {
      calls.push(bootstrap ? 'bootstrap-connect' : 'device-connect');
      if (unavailable) throw new Error('fixture-secret-must-not-escape');
      if (bootstrap && pending) {
        requestId = 'request-1';
        throw new Error('pending');
      }
      if (bootstrap) {
        paired = true;
        requestId = undefined;
      }
      if (!paired) throw new Error('revoked');
      return {
        token: bootstrap ? 'fixture-device-token' : record.token,
        scopes: [...sessionDispatchScopes],
      };
    },
    now: () => now,
  };
  return {
    dependencies,
    service: new SessionDispatchCredential(dependencies),
    calls,
    record: () => (value ? (JSON.parse(value) as DispatchCredential) : undefined),
    setPending: (next: boolean) => {
      pending = next;
    },
    setPaired: (next: boolean) => {
      paired = next;
    },
    setUnavailable: () => {
      unavailable = true;
    },
    failWrite: () => {
      failedWrite = true;
    },
    expire: () => {
      now += 1001;
    },
  };
}

describe('credentials/session-dispatch', () => {
  for (const [category, failure, phase, reasonCode] of [
    [
      'timeout',
      new GatewayClientRequestTimeoutError({ method: 'connect', timeoutMs: 1, requestSent: true }),
      'handshake',
      'connect-request-timeout',
    ],
    [
      'transport',
      Object.assign(new Error('private-token'), { code: 'ECONNREFUSED' }),
      'connection',
      'connection-refused',
    ],
    [
      'gateway-rejected',
      new GatewayClientRequestError({
        code: 'FORBIDDEN',
        message: 'private-token',
        details: { token: 'private-token' },
      }),
      'unknown',
      'forbidden',
    ],
  ] as const) {
    it(`should retain bounded ${category} evidence and resume the same enrollment identity`, async () => {
      const f = fixture();
      const connect = f.dependencies.connect;
      f.dependencies.connect = async () => {
        throw failure;
      };
      await assert.rejects(f.service.enroll({ sessionDispatchConsent: true }), (error: unknown) => {
        assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
        assert.deepEqual(error.sessionDispatchDiagnostic, { category, phase, reasonCode });
        assert.equal(error.cause, undefined);
        assert.ok(!JSON.stringify(error).includes('private-token'));
        return true;
      });
      const retained = f.record()!;
      assert.ok(retained.bootstrap);
      assert.equal(retained.token, undefined);
      f.dependencies.connect = connect;
      assert.equal((await f.service.enroll({ sessionDispatchConsent: true })).status, 'created');
      assert.equal(f.record()!.device.deviceId, retained.device.deviceId);
      assert.equal(f.calls.filter((call) => call === 'issue').length, 1);
      assert.ok(!f.calls.includes('remove'));
    });
  }

  it('should inspect missing enrollment without issuing or persisting credentials', async () => {
    const f = fixture();
    assert.equal((await f.service.inspect()).code, 'session-dispatch-credential-missing');
    assert.deepEqual(f.calls, []);
    await assert.rejects(f.service.enroll({}), { code: 'session-dispatch-approval-required' });
    assert.deepEqual(f.calls, []);
  });

  it('should persist one identity, reconnect device-only, and reuse it across service restarts', async () => {
    const f = fixture();
    assert.equal((await f.service.enroll({ sessionDispatchConsent: true })).status, 'created');
    const first = f.record()!;
    assert.equal(first.bootstrap, undefined);
    assert.equal(first.token, 'fixture-device-token');
    assert.ok(f.calls.indexOf('store') < f.calls.indexOf('issue'));
    const restarted = new SessionDispatchCredential(f.dependencies);
    assert.equal((await restarted.enroll({})).status, 'unchanged');
    assert.equal(f.record()!.device.deviceId, first.device.deviceId);
    assert.equal(f.calls.filter((call) => call === 'issue').length, 1);
    assert.equal(f.calls.filter((call) => call === 'bootstrap-connect').length, 1);
    assert.ok(f.calls.includes('device-connect'));
    const safe = JSON.stringify(await restarted.inspect());
    assert.ok(!safe.includes('fixture-device-token'));
    assert.ok(!safe.includes('PRIVATE KEY'));
  });

  it('should keep credential operations device-only and fail before use on missing or revoked authority', async () => {
    const f = fixture();
    let uses = 0;
    f.dependencies.use = async (record, authority, operation) => {
      uses++;
      assert.equal(record.token, 'fixture-device-token');
      assert.equal(record.bootstrap, undefined);
      await authority.assertCurrent?.();
      return operation(async () => ({ ok: true }), [...sessionDispatchScopes]);
    };
    await assert.rejects(
      f.service.use({}, async () => 'no'),
      { code: 'session-dispatch-credential-missing' },
    );
    assert.equal(uses, 0);
    await f.service.enroll({ sessionDispatchConsent: true });
    const before = [...f.calls];
    assert.deepEqual(
      await f.service.use({}, (request) => request('sessions.describe', { key: 'fixture' })),
      { ok: true },
    );
    assert.deepEqual(f.calls, before);
    f.setPaired(false);
    await assert.rejects(
      f.service.use({}, async () => 'no'),
      { code: 'session-dispatch-credential-revoked' },
    );
    assert.equal(uses, 1);
  });

  it('should verify granted scopes and current authority before every session request', async () => {
    const f = fixture();
    await f.service.enroll({ sessionDispatchConsent: true });
    let requests = 0;
    f.dependencies.use = async (_record, _authority, operation) =>
      operation(async () => {
        requests++;
      }, ['operator.admin']);
    await assert.rejects(
      f.service.use({}, (request) => request('sessions.describe', {})),
      { code: 'session-dispatch-scope-mismatch' },
    );
    assert.equal(requests, 0);
    f.dependencies.use = async (_record, _authority, operation) =>
      operation(async () => {
        requests++;
      }, [...sessionDispatchScopes]);
    let current = true;
    await assert.rejects(
      f.service.use(
        {
          assertCurrent: async () => {
            if (!current) throw new Error('stale');
          },
        },
        async (request) => {
          await request('sessions.describe', {});
          current = false;
          await request('sessions.describe', {});
        },
      ),
      /stale/,
    );
    assert.equal(requests, 1);
  });

  it('should retain pending pairing across restart and renew only its expired bootstrap', async () => {
    const f = fixture();
    f.setPending(true);
    await assert.rejects(f.service.enroll({ sessionDispatchConsent: true }), {
      code: 'session-dispatch-pairing-pending',
    });
    const deviceId = f.record()!.device.deviceId;
    const before = [...f.calls];
    assert.match((await f.service.inspect()).remediation!, /devices approve request-1/);
    assert.deepEqual(f.calls, before);
    f.expire();
    f.setPending(false);
    await new SessionDispatchCredential(f.dependencies).enroll({ sessionDispatchConsent: true });
    assert.equal(f.record()!.device.deviceId, deviceId);
    assert.equal(f.calls.filter((call) => call === 'issue').length, 2);
  });

  it('should replace a revoked identity only after device removal and explicit install consent', async () => {
    const f = fixture();
    await f.service.enroll({ sessionDispatchConsent: true });
    const previousId = f.record()!.device.deviceId;
    f.setPaired(false);
    assert.equal((await f.service.inspect()).code, 'session-dispatch-credential-revoked');
    const before = [...f.calls];
    await assert.rejects(f.service.enroll({}), {
      code: 'session-dispatch-credential-revoked',
    });
    assert.deepEqual(f.calls, before);
    assert.equal((await f.service.enroll({ sessionDispatchConsent: true })).status, 'created');
    assert.notEqual(f.record()!.device.deviceId, previousId);
    assert.equal(f.calls.filter((call) => call === 'remove').length, 1);
  });

  it('should preserve authorization uncertainty without exposing connection errors or re-enrolling', async () => {
    const f = fixture();
    await f.service.enroll({ sessionDispatchConsent: true });
    f.setUnavailable();
    const finding = await f.service.inspect();
    assert.equal(finding.code, 'session-dispatch-verification-unavailable');
    assert.ok(!JSON.stringify(finding).includes('fixture-secret'));
    assert.equal(f.calls.filter((call) => call === 'issue').length, 1);
  });

  it('should preserve diagnostics and exact pairing recovery without replacing an existing identity', async () => {
    const f = fixture();
    f.setPending(true);
    await assert.rejects(f.service.enroll({ sessionDispatchConsent: true }), (error: unknown) => {
      assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
      assert.deepEqual(error.sessionDispatchDiagnostic, {
        category: 'unknown',
        phase: 'unknown',
        reasonCode: 'unknown',
      });
      assert.match(error.message, /devices approve request-1/);
      assert.ok(error.message.includes(f.record()!.device.deviceId));
      return true;
    });
    f.setPending(false);
    await f.service.enroll({ sessionDispatchConsent: true });
    const retained = f.record()!;
    f.setUnavailable();
    const before = [...f.calls];
    await assert.rejects(f.service.enroll({ sessionDispatchConsent: true }), (error: unknown) => {
      assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
      assert.deepEqual(error.sessionDispatchDiagnostic, {
        category: 'unknown',
        phase: 'unknown',
        reasonCode: 'unknown',
      });
      assert.ok(!error.message.includes('fixture-secret'));
      return true;
    });
    assert.deepEqual(f.record(), retained);
    assert.deepEqual(f.calls.slice(before.length), ['device-connect']);
  });

  it('should preserve cancellation and current authority after failed or successful connection', async () => {
    for (const remoteFails of [false, true]) {
      for (const cancelled of [false, true]) {
        const f = fixture();
        const controller = new AbortController();
        const failure = new Error('authority-changed');
        let changed = false;
        f.dependencies.connect = async () => {
          changed = true;
          if (cancelled) controller.abort(failure);
          if (remoteFails) throw new Error('private-token');
          return { token: 'fixture-device-token', scopes: [...sessionDispatchScopes] };
        };
        await assert.rejects(
          f.service.enroll({
            sessionDispatchConsent: true,
            signal: controller.signal,
            assertEnrollmentCurrent() {
              if (changed && !cancelled) throw failure;
            },
          }),
          (error: unknown) => error === failure,
        );
        assert.equal(f.record()!.token, undefined);
        assert.ok(f.record()!.bootstrap);
        assert.ok(!f.calls.includes('remove'));
      }
    }
  });

  it('should stop before issuance when protected persistence or current authority fails', async () => {
    const f = fixture();
    f.failWrite();
    await assert.rejects(f.service.enroll({ sessionDispatchConsent: true }), {
      code: 'session-dispatch-storage-unavailable',
    });
    assert.ok(!f.calls.includes('issue'));
    const g = fixture();
    await assert.rejects(
      g.service.enroll({
        sessionDispatchConsent: true,
        assertEnrollmentCurrent() {
          throw new Error('cancelled');
        },
      }),
      /cancelled/,
    );
    assert.deepEqual(g.calls, []);
  });

  it('should revoke newly issued bootstrap material when its persistence fails', async () => {
    const f = fixture();
    const issue = f.dependencies.issue;
    f.dependencies.issue = async (guard) => {
      const result = await issue(guard);
      f.failWrite();
      return result;
    };
    await assert.rejects(f.service.enroll({ sessionDispatchConsent: true }), {
      code: 'session-dispatch-storage-unavailable',
    });
    assert.ok(f.calls.includes('revoke'));
    assert.ok(!f.calls.includes('bootstrap-connect'));
  });

  it('should reject grants beyond the disclosed scopes', async () => {
    const f = fixture();
    const connect = f.dependencies.connect;
    f.dependencies.connect = async (...args) => ({
      ...(await connect(...args)),
      scopes: ['operator.admin'],
    });
    await assert.rejects(f.service.enroll({ sessionDispatchConsent: true }), {
      code: 'session-dispatch-scope-mismatch',
    });
    assert.equal(f.record()!.token, undefined);
  });
});

describe('agent/session-dispatch-requirements', () => {
  it('should derive required consumers from effective runtime and trigger policy', () => {
    const value = manifest();
    assert.deepEqual(
      sessionDispatchRequirements(value).map(({ id }) => id),
      ['github-issue-assignment'],
    );
    const policy = value.github!.notifications!;
    assert.equal(policy.schemaVersion, 3);
    if (policy.schemaVersion !== 3) throw new Error();
    policy.reviewRequest = { ...policy.issueAssignment! };
    assert.equal(sessionDispatchRequirements(value).length, 1);
    policy.issueAssignment!.paused = true;
    assert.deepEqual(
      sessionDispatchRequirements(value).map(({ id }) => id),
      ['github-issue-assignment'],
    );
    policy.runtimes = ['codex'];
    assert.deepEqual(sessionDispatchRequirements(value), []);
  });

  it('should skip storage and enrollment when no consumer requires dispatch', async () => {
    const f = fixture();
    const value: AgentManifest = { schemaVersion: 1, agent: { id: 'test' } };
    const lifecycle = createSessionDispatchLifecycle(f.service);
    assert.equal(
      (await lifecycle.inspect!({ manifest: value, workspaceDir: '/test' }))[0]!.status,
      'skipped',
    );
    await lifecycle.reconcile!({ manifest: value, workspaceDir: '/test' });
    assert.deepEqual(f.calls, []);
  });

  it('should require consent before any install reconciliation', async () => {
    let reconciled = false;
    const install = new AgentInstallService({
      sessionDispatch: { needsEnrollment: async () => true },
      lifecycleRegistry: {
        reconcile: async () => {
          reconciled = true;
          return { outcomes: [], warnings: [] };
        },
      },
    });
    await assert.rejects(
      install.install({ manifest: manifest(), workspaceDir: '/test', runtime: 'openclaw' }),
      { code: 'session-dispatch-approval-required' },
    );
    assert.equal(reconciled, false);
  });
});

describe('cli/session-dispatch-consent', () => {
  const consumers = [{ name: 'issue assignments' }, { name: 'pull request reviews' }];
  function options(tty: boolean) {
    const input = Object.assign(Readable.from([]), { isTTY: tty });
    const stderr: string[] = [];
    return {
      runtime: 'openclaw' as const,
      workspaceDir: '/test',
      input,
      environment: {},
      output: {
        writeStdout() {
          throw new Error('json pollution');
        },
        writeStderr: (text: string) => {
          stderr.push(text);
        },
      },
      stderr,
    };
  }
  it('should accept explicit yes without a tty while disclosing the consumers and actual grants', async () => {
    const value = options(false);
    assert.equal(await confirmSessionDispatch({ ...value, yes: true }, consumers), true);
    for (const word of [
      'issue assignments',
      'pull request reviews',
      'operator.read',
      'operator.write',
      'broader',
    ])
      assert.ok(value.stderr.join('').includes(word));
  });
  it('should never infer consent from ci, noninteractive, or missing tty', async () => {
    for (const value of [
      options(false),
      { ...options(true), nonInteractive: true },
      { ...options(true), environment: { CI: 'true' } },
    ]) {
      assert.equal(
        await confirmSessionDispatch(
          {
            ...value,
            prompt: async () => {
              throw new Error('unexpected prompt');
            },
          },
          consumers,
        ),
        false,
      );
    }
  });
  it('should use an explicit default-no interactive decision and preserve denial', async () => {
    assert.equal(
      await confirmSessionDispatch(
        {
          ...options(true),
          prompt: async ({ initialValue }) => {
            assert.equal(initialValue, false);
            return true;
          },
        },
        consumers,
      ),
      true,
    );
    assert.equal(
      await confirmSessionDispatch({ ...options(true), prompt: async () => false }, consumers),
      false,
    );
  });
});
