import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acknowledgeCodexIntakePermission,
  inspectCodexIntakePermission,
  type IntakePermissionDependencies,
} from '../agent/codex-intake-permission.ts';

describe('agent/codex-intake-permission', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intake-permission-'));
  });
  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });
  function fixture() {
    const context = { pluginData: root, workspace: '/workspace', codexHome: '/profile' };
    const argv = ['/node', '/plugin/runtime.js', 'intake', 'scan', '--plugin-data', root];
    const policy = {
      decision: 'allow',
      revision: 'first',
      matchedRules: [{ prefixRuleMatch: { decision: 'allow', matchedPrefix: argv } }],
    };
    const deps = { argv, policy: async () => policy };
    return { context, policy, deps };
  }
  it('should evaluate active native rule layers and reject unmanaged policy uncertainty', async () => {
    const { context, policy, deps: fixtureDeps } = fixture();
    const rules = join(root, 'rules');
    await mkdir(rules);
    await writeFile(join(rules, 'consent.rules'), 'fixture rule');
    let closed = 0;
    let evaluated = 0;
    let requirements: unknown = null;
    const deps: IntakePermissionDependencies = {
      argv: fixtureDeps.argv,
      connect: async () => ({
        request: async (method) =>
          method === 'config/read'
            ? {
                layers: [
                  { name: { type: 'user', file: join(root, 'config.toml') }, config: {} },
                  {
                    name: { type: 'project', dotCodexFolder: '/untrusted' },
                    disabledReason: 'untrusted',
                    config: {},
                  },
                ],
              }
            : { requirements },
        close: async () => {
          closed++;
        },
      }),
      run: async (argv) => {
        evaluated++;
        assert.deepEqual(argv.slice(0, 7), [
          'codex',
          'execpolicy',
          'check',
          '--resolve-host-executables',
          '--rules',
          join(rules, 'consent.rules'),
          '--',
        ]);
        assert.deepEqual(argv.slice(7), fixtureDeps.argv);
        return {
          code: 0,
          killed: false,
          signal: null,
          termination: 'exit',
          stdout: JSON.stringify(policy),
          stderr: '',
        };
      },
    };
    const inspection = await inspectCodexIntakePermission(context, deps);
    assert.equal(inspection.code, 'intake-permission-reload-required');
    await acknowledgeCodexIntakePermission(
      context,
      { digest: inspection.digest, confirmReload: true },
      deps,
    );
    await writeFile(join(rules, 'consent.rules'), 'fixture rule\nunrelated command approval');
    assert.equal((await inspectCodexIntakePermission(context, deps)).status, 'acknowledged');
    policy.matchedRules.push({ prefixRuleMatch: { decision: 'allow', matchedPrefix: ['/node'] } });
    assert.equal(
      (await inspectCodexIntakePermission(context, deps)).code,
      'intake-permission-stale',
    );
    const evaluatedBeforeManaged = evaluated;
    const closedBeforeManaged = closed;
    requirements = { rules: { prefix_rules: [] } };
    assert.equal(
      (await inspectCodexIntakePermission(context, deps)).code,
      'intake-permission-managed-policy-unverified',
    );
    assert.equal(evaluated, evaluatedBeforeManaged);
    assert.equal(closed, closedBeforeManaged + 1);
  });
  it('should require exact recurring permission and leave inspection read-only', async () => {
    const { context, policy, deps } = fixture();
    policy.matchedRules = [];
    assert.equal(
      (await inspectCodexIntakePermission(context, deps)).code,
      'intake-permission-required',
    );
    policy.matchedRules = [{ prefixRuleMatch: { decision: 'allow', matchedPrefix: ['/node'] } }];
    assert.equal(
      (await inspectCodexIntakePermission(context, deps)).code,
      'intake-permission-required',
    );
    assert.deepEqual(await readdir(root), []);
  });
  it('should require explicit reload acknowledgment without claiming verified execution', async () => {
    const { context, deps } = fixture();
    const before = await inspectCodexIntakePermission(context, deps);
    assert.equal(before.code, 'intake-permission-reload-required');
    for (const input of [{ digest: before.digest }, { digest: 'stale', confirmReload: true }])
      await assert.rejects(acknowledgeCodexIntakePermission(context, input, deps), {
        code: 'intake-permission-acknowledgment-required',
      });
    const after = await acknowledgeCodexIntakePermission(
      context,
      { digest: before.digest, confirmReload: true },
      deps,
    );
    assert.equal(after.status, 'acknowledged');
    assert.equal(after.execution, 'unverified');
    assert.equal(after.reloadAcknowledged, true);
    assert.equal((await inspectCodexIntakePermission(context, deps)).status, 'acknowledged');
  });
  it('should invalidate prior acknowledgment when rules, executable, workspace, or profile change', async () => {
    const { context, policy, deps } = fixture();
    const before = await inspectCodexIntakePermission(context, deps);
    await acknowledgeCodexIntakePermission(
      context,
      { digest: before.digest, confirmReload: true },
      deps,
    );
    policy.revision = 'changed rules';
    assert.equal(
      (await inspectCodexIntakePermission(context, deps)).code,
      'intake-permission-stale',
    );
    policy.revision = 'first';
    deps.argv[0] = '/new-node';
    assert.equal(
      (await inspectCodexIntakePermission(context, deps)).code,
      'intake-permission-stale',
    );
    for (const changed of [
      { ...context, workspace: '/another-workspace' },
      { ...context, codexHome: '/another-profile' },
    ])
      assert.equal(
        (await inspectCodexIntakePermission(changed, deps)).code,
        'intake-permission-reload-required',
      );
  });
  it('should honor native denials and never expose captured failure text', async () => {
    const { context, policy, deps } = fixture();
    for (const decision of ['prompt', 'forbidden']) {
      policy.decision = decision;
      const inspected = await inspectCodexIntakePermission(context, deps);
      assert.equal(inspected.code, 'intake-permission-denied');
      await assert.rejects(
        acknowledgeCodexIntakePermission(
          context,
          { digest: inspected.digest, confirmReload: true },
          deps,
        ),
      );
    }
    deps.policy = async () => {
      throw new Error('private captured output');
    };
    const result = await inspectCodexIntakePermission(context, deps);
    assert.equal(result.code, 'intake-permission-inspection-unavailable');
    assert.ok(!JSON.stringify(result).includes('private captured output'));
  });
});
