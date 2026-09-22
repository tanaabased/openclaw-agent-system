import assert from 'node:assert/strict';

import AgentDoctorService from '../agent/doctor-service.ts';
import AgentInstallService from '../agent/install-service.ts';
import SetupLifecycleService from '../agent/setup-lifecycle.ts';
import AgentSystemLifecycleRegistry, {
  type AgentSystemLifecycleContribution,
} from '../core/lifecycle-registry.ts';
import { normalizeAgentSetup } from '../manifest/setup-schema.ts';

function fixture() {
  const normalized = normalizeAgentSetup({
    steps: [
      { id: 'clone', check: 'clone check', apply: 'clone apply' },
      { id: 'configure', check: 'configure check', apply: 'configure apply' },
    ],
  });
  assert.equal(normalized.status, 'valid');
  const context = {
    manifest: { schemaVersion: 1 as const, agent: { id: 'emori' }, setup: normalized.setup },
    workspaceDir: '/workspace/emori',
  };
  const calls: string[] = [];
  const installed = new Set<string>();
  const state = { failedOwner: '', blockedOwner: '', failedSetup: '', unavailable: false };
  const ids = [
    'agent',
    'models',
    'memory',
    'tool-access',
    'security',
    'path',
    'git',
    'github',
    'notifications',
  ];
  const contributions: AgentSystemLifecycleContribution[] = ids.map((id) => ({
    id,
    isConfigured: () => true,
    async reconcile() {
      calls.push(`install:${id}`);
      if (state.failedOwner === id) throw new Error('private owner failure');
      const exists = installed.has(id);
      installed.add(id);
      return {
        outcomes: [{ code: 'ready', message: id, status: exists ? 'unchanged' : 'created' }],
        warnings:
          id === 'path' ? [{ code: 'path-warning', message: 'manual path configuration' }] : [],
      };
    },
    async inspect() {
      calls.push(`inspect:${id}`);
      return [
        {
          code: 'inspected',
          message: id,
          status: state.blockedOwner === id ? 'blocked' : 'healthy',
        },
      ];
    },
  }));
  const setup = new SetupLifecycleService({
    async run(command, target) {
      assert.equal(command.kind, 'shell');
      if (command.kind !== 'shell') throw new Error('expected script');
      const [id, mode] = command.script.split(' ');
      assert.equal(target.mode, mode);
      calls.push(`setup:${id}:${mode}`);
      if (state.unavailable) throw new Error('private prerequisite details');
      const key = `setup:${id}`;
      if (mode === 'apply') installed.add(key);
      const exitCode =
        state.failedSetup === id && mode === 'apply' ? 2 : installed.has(key) ? 0 : 1;
      return { exitCode, timedOut: false, truncated: false };
    },
  });
  const registry = new AgentSystemLifecycleRegistry(contributions, setup);
  return {
    context,
    calls,
    installed,
    state,
    ids,
    registry,
    install: new AgentInstallService({ lifecycleRegistry: registry }),
    doctor: new AgentDoctorService({ lifecycleRegistry: registry }),
  };
}

describe('setup installation lifecycle', () => {
  it('should reconcile prerequisites before setup and dependent state afterward', async () => {
    const { install, context, calls } = fixture();
    const result = await install.install(context);
    assert.deepEqual(calls, [
      'install:agent',
      'install:path',
      'install:git',
      'install:github',
      'inspect:agent',
      'inspect:path',
      'inspect:git',
      'inspect:github',
      'setup:clone:check',
      'setup:clone:apply',
      'setup:clone:check',
      'setup:configure:check',
      'setup:configure:apply',
      'setup:configure:check',
      'install:models',
      'install:memory',
      'install:tool-access',
      'install:security',
      'install:notifications',
    ]);
    assert.deepEqual(
      result.outcomes.map(({ component }) => component),
      [
        'agent',
        'path',
        'git',
        'github',
        'setup',
        'setup',
        'models',
        'memory',
        'tool-access',
        'security',
        'notifications',
      ],
    );
    assert.equal(result.warnings[0]?.code, 'path-warning');
  });

  it('should preserve existing ordering and avoid setup for manifests without it', async () => {
    const {
      install,
      context: { manifest, workspaceDir },
      calls,
      ids,
    } = fixture();
    await install.install({
      manifest: { schemaVersion: manifest.schemaVersion, agent: manifest.agent },
      workspaceDir,
    });
    assert.deepEqual(
      calls,
      ids.map((id) => `install:${id}`),
    );
  });

  it('should stop before setup if prerequisite reconciliation fails', async () => {
    const { install, context, calls, installed, state } = fixture();
    state.failedOwner = 'github';
    await assert.rejects(install.install(context), {
      component: 'github',
      code: 'github-reconcile-failed',
    });
    assert.deepEqual(calls, ['install:agent', 'install:path', 'install:git', 'install:github']);
    assert.deepEqual([...installed], ['agent', 'path', 'git']);
  });

  it('should block setup when a reconciled prerequisite reports unavailable dependencies', async () => {
    const { install, context, calls, state } = fixture();
    state.blockedOwner = 'git';
    await assert.rejects(install.install(context), {
      component: 'git',
      code: 'setup-prerequisite-blocked',
    });
    assert.ok(!calls.some((call) => call.startsWith('setup:')));
    assert.ok(!calls.includes('install:models'));
  });

  it('should retain partial effects and retry from observed state after setup failure', async () => {
    const { install, context, calls, installed, state } = fixture();
    state.failedSetup = 'configure';
    await assert.rejects(install.install(context), {
      stepId: 'configure',
      code: 'setup-apply-failed',
    });
    assert.ok(installed.has('github'));
    assert.ok(installed.has('setup:clone'));
    assert.ok(installed.has('setup:configure'));
    assert.ok(!installed.has('models'));
    calls.length = 0;
    state.failedSetup = '';
    const result = await install.install(context);
    assert.ok(!calls.some((call) => call.endsWith(':apply')));
    assert.ok(installed.has('notifications'));
    assert.deepEqual(
      result.outcomes.filter(({ component }) => component === 'setup').map(({ status }) => status),
      ['unchanged', 'unchanged'],
    );
  });

  it('should inspect all checks without prerequisite repair or applying setup', async () => {
    const { doctor, context, calls, installed, state } = fixture();
    state.unavailable = true;
    const result = await doctor.inspect(context);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(
      result.findings
        .filter(({ component }) => component === 'setup')
        .map(({ stepId, status }) => [stepId, status]),
      [
        ['clone', 'blocked'],
        ['configure', 'blocked'],
      ],
    );
    assert.ok(calls.includes('setup:clone:check'));
    assert.ok(calls.includes('setup:configure:check'));
    assert.ok(calls.includes('inspect:notifications'));
    assert.ok(!calls.some((call) => call.startsWith('install:') || call.endsWith(':apply')));
    assert.equal(installed.size, 0);
  });

  it('should skip the entire setup phase without changing doctor findings', async () => {
    const { install, doctor, context, calls, ids, state } = fixture();
    state.unavailable = true;
    const result = await install.install({ ...context, skipSetup: true });
    assert.deepEqual(
      calls,
      ids.map((id) => `install:${id}`),
    );
    assert.ok(!result.outcomes.some(({ component }) => component === 'setup'));
    assert.equal(result.warnings[0]?.code, 'setup-skipped');
    calls.length = 0;
    const findings = await doctor.inspect(context);
    assert.equal(findings.status, 'blocked');
    assert.ok(calls.includes('setup:clone:check'));
  });

  it('should stop before setup when tool preparation fails', async () => {
    let commands = 0;
    const { context } = fixture();
    const setup = new SetupLifecycleService({
      async prepare() {
        throw new Error('private credential failure');
      },
      async run() {
        commands++;
        return { exitCode: 0, timedOut: false, truncated: false };
      },
    });
    await assert.rejects(setup.reconcile(context), { code: 'setup-prerequisite-blocked' });
    assert.equal(commands, 0);
    const findings = await setup.inspect(context);
    assert.ok(findings.every(({ status }) => status === 'healthy'));
    assert.equal(commands, 2);
  });

  it('should keep validation nonexecuting and reject unconfigured setup execution', async () => {
    const { context, calls, registry } = fixture();
    registry.validate(context);
    assert.deepEqual(calls, []);
    await assert.rejects(new AgentSystemLifecycleRegistry([]).reconcile(context), {
      code: 'setup-unavailable',
    });
  });
});
