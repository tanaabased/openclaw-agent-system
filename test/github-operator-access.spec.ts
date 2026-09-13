import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import GitHubOperatorAccess, { operatorOwnerIdentity } from '../channels/github/operator-access.ts';
import OperatorGrantStore, {
  type OperatorGrantState,
  validOperatorGrantState,
} from '../channels/github/operator-grant-store.ts';
import type { AgentSystemLifecycleContext } from '../core/lifecycle-registry.ts';

const actor = { login: 'actor', nodeId: 'U_actor', operatorOwner: true };
const identity = operatorOwnerIdentity(actor);
function context(agentId = 'data', enabled = true): AgentSystemLifecycleContext {
  return {
    workspaceDir: `/workspace/${agentId}`,
    manifest: {
      schemaVersion: 1,
      agent: { id: agentId },
      github: {
        notifications: {
          assignmentTypes: ['issue'],
          intervalMinutes: 5,
          approvedActors: [{ ...actor, operatorOwner: enabled }],
        },
      },
    },
  };
}

function fixture() {
  let state: OperatorGrantState = { schemaVersion: 1, grants: [] };
  let config: OpenClawConfig = {};
  let writes = 0;
  let fail: 'identity' | 'intent-readback' | 'mutation' | 'receipt' | 'readback' | undefined;
  const plans: string[] = [];
  const service = new GitHubOperatorAccess({
    accountClient: {
      async connect() {
        return {
          identity: { login: 'data', nodeId: 'U_data' },
          async execute(argv) {
            const login = argv[1]!.slice('users/'.length);
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                login,
                nodeId: fail === 'identity' ? 'wrong' : `U_${login}`,
              }),
              stderr: '',
              truncated: false,
              timedOut: false,
            };
          },
        };
      },
    },
    store: {
      async read() {
        return structuredClone(state);
      },
      async write(next) {
        if (fail === 'intent-readback') return;
        if (fail === 'receipt' && writes > 0) throw new Error('receipt unavailable');
        state = structuredClone(next);
      },
      async withLock(run) {
        return run();
      },
    },
    async mutateConfigFile(params) {
      if (fail === 'mutation') throw new Error('write interrupted');
      const draft = structuredClone(config);
      const result = params.mutate(draft);
      writes++;
      if (fail !== 'readback') config = draft;
      return { result: result === true };
    },
    readConfig: () => structuredClone(config),
    readRuntimeConfig: () => ({}),
    reportPlan: (message) => plans.push(message),
  });
  return {
    service,
    plans,
    get state() {
      return state;
    },
    get config() {
      return config;
    },
    set config(value) {
      config = value;
    },
    get writes() {
      return writes;
    },
    set fail(value: typeof fail) {
      fail = value;
    },
  };
}

describe('github operator access', () => {
  it('should default to no grants and no recurring missing-access warnings', async () => {
    const f = fixture();
    assert.deepEqual(await f.service.inspect(context('data', false)), []);
    assert.deepEqual(await f.service.reconcile(context('data', false)), {
      outcomes: [],
      warnings: [],
    });
    assert.equal(f.writes, 0);
  });

  it('should diagnose without mutation and grant only verified flagged identities idempotently', async () => {
    const f = fixture();
    f.config = { commands: { ownerAllowFrom: ['discord:keep', 123] } };
    const ctx = context();
    ctx.manifest.github!.notifications!.approvedActors.push(
      { login: 'second', nodeId: 'U_second', operatorOwner: true },
      { login: 'third', nodeId: 'U_third' },
    );
    const findings = await f.service.inspect(ctx);
    assert.equal(findings.length, 2);
    assert.ok(
      findings.every(
        (finding) => finding.status === 'warning' && finding.remediation?.includes('install'),
      ),
    );
    assert.equal(f.writes, 0);
    const result = await f.service.reconcile(ctx);
    assert.equal(result.outcomes[0]?.status, 'updated');
    assert.match(result.outcomes[0]?.message ?? '', /^Operator entries for actor, second are saved\.$/u);
    assert.deepEqual(f.config.commands?.ownerAllowFrom, [
      'discord:keep',
      123,
      identity,
      'agent-system-github:U_second',
    ]);
    assert.equal(f.state.grants.length, 2);
    await f.service.reconcile(ctx);
    assert.equal(f.writes, 1);
    assert.ok(f.plans[0]?.includes('channel-wide'));
    assert.ok(
      result.warnings.some(
        (finding) =>
          finding.code === 'github-operator-loaded-access-unverified' &&
          finding.message.includes('Reload the Gateway'),
      ),
    );
  });

  it('should reject mismatched pins before writing either grants or claims', async () => {
    const f = fixture();
    f.fail = 'identity';
    const result = await f.service.reconcile(context());
    assert.equal(f.writes, 0);
    assert.deepEqual(f.state.grants, []);
    assert.equal(result.warnings[0]?.code, 'github-operator-identity-unverified');
  });

  it('should preserve manual and unrelated entries through deduplication and opt-out', async () => {
    const f = fixture();
    f.config = { commands: { ownerAllowFrom: ['slack:keep', identity, identity] } };
    await f.service.reconcile(context());
    assert.deepEqual(f.config.commands?.ownerAllowFrom, ['slack:keep', identity]);
    const result = await f.service.reconcile(context('data', false));
    assert.deepEqual(f.config.commands?.ownerAllowFrom, ['slack:keep', identity]);
    assert.equal(result.warnings[0]?.code, 'github-operator-grant-retained');
  });

  it('should retain shared grants until the last installation retires its declaration', async () => {
    const f = fixture();
    await f.service.reconcile(context());
    await f.service.reconcile(context('other'));
    assert.equal(f.state.grants[0]?.claims.length, 2);
    await f.service.reconcile(context('data', false));
    assert.deepEqual(f.config.commands?.ownerAllowFrom, [identity]);
    const removed = context('other');
    delete removed.manifest.github;
    await f.service.reconcile(removed);
    assert.deepEqual(f.config.commands?.ownerAllowFrom, []);
    assert.deepEqual(f.state.grants, []);
  });

  for (const failure of ['mutation', 'receipt', 'readback'] as const) {
    it(`should preserve uncertain provenance after a failed ${failure}`, async () => {
      const f = fixture();
      f.fail = failure;
      const result = await f.service.reconcile(context());
      assert.equal(result.outcomes.length, 0);
      assert.ok(
        result.warnings.some(
          (finding) => finding.code === 'github-operator-reconciliation-unverified',
        ),
      );
      assert.equal(f.state.grants[0]?.origin, 'ambiguous');
      f.fail = undefined;
      const retired = await f.service.reconcile(context('data', false));
      if (failure === 'receipt') {
        assert.deepEqual(f.config.commands?.ownerAllowFrom, [identity]);
        assert.ok(
          retired.warnings.some((finding) => finding.code === 'github-operator-grant-retained'),
        );
      }
    });
  }

  it('should detect newly duplicated owned grants as ambiguous and preserve access', async () => {
    const f = fixture();
    await f.service.reconcile(context());
    f.config.commands!.ownerAllowFrom!.push(identity);
    const result = await f.service.reconcile(context('data', false));
    assert.deepEqual(f.config.commands?.ownerAllowFrom, [identity, identity]);
    assert.ok(result.warnings.some((finding) => finding.code === 'github-operator-grant-retained'));
  });

  it('should withhold new grants when the write-ahead provenance cannot be read back', async () => {
    const f = fixture();
    f.fail = 'intent-readback';
    const result = await f.service.reconcile(context());
    assert.equal(f.writes, 0);
    assert.deepEqual(f.state.grants, []);
    assert.equal(result.outcomes.length, 0);
    assert.ok(
      result.warnings.some(
        (finding) => finding.code === 'github-operator-reconciliation-unverified',
      ),
    );
  });

  it('should retain uncertain access and report failed retirement on the next install', async () => {
    const f = fixture();
    await f.service.reconcile(context());
    f.fail = 'mutation';
    const failed = await f.service.reconcile(context('data', false));
    assert.equal(failed.outcomes.length, 0);
    assert.deepEqual(f.config.commands?.ownerAllowFrom, [identity]);
    assert.equal(f.state.grants[0]?.origin, 'ambiguous');
    assert.equal(f.state.grants[0]?.claims.length, 1);
    f.fail = undefined;
    const retried = await f.service.reconcile(context('data', false));
    assert.deepEqual(f.config.commands?.ownerAllowFrom, [identity]);
    assert.ok(
      retried.warnings.some(
        (finding) =>
          finding.code === 'github-operator-grant-retained' &&
          finding.message.includes('Revocation was not performed'),
      ),
    );
  });

  it('should distinguish explicit tool denial from missing owner access without overriding it', async () => {
    const f = fixture();
    f.config = { tools: { deny: ['sessions'] } };
    const result = await f.service.reconcile(context());
    assert.deepEqual(f.config.tools?.deny, ['sessions']);
    assert.ok(
      result.warnings.some((finding) => finding.code === 'github-operator-sessions-denied'),
    );
  });

  it('should serialize shared receipts and reject unqualified or malformed provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'operator-grants-'));
    try {
      const store = new OperatorGrantStore({ rootDir: root, currentUid: process.getuid?.() });
      await Promise.all(
        ['first', 'second'].map((agentId) =>
          store.withLock(async () => {
            const state = await store.read();
            const grant = state.grants[0] ?? { identity, origin: 'created' as const, claims: [] };
            grant.claims.push({ agentId, workspaceDir: `/workspace/${agentId}` });
            await store.write({ schemaVersion: 1, grants: [grant] });
          }),
        ),
      );
      assert.equal((await store.read()).grants[0]?.claims.length, 2);
      assert.equal(
        validOperatorGrantState({
          schemaVersion: 1,
          grants: [{ identity: 'U_actor', origin: 'created', claims: [] }],
        }),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
