import assert from 'node:assert/strict';

import { buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';

import cleanupConfiguration, {
  openClawCleanupConfiguration,
  parseCleanupConfiguration,
} from '../agent/cleanup-configuration.ts';
import pluginManifest from '../openclaw.plugin.json' with { type: 'json' };

const nativeSchema = buildJsonPluginConfigSchema(pluginManifest.configSchema);
const codexConfiguration = (config: unknown) =>
  cleanupConfiguration({
    env: { OPENCLAW_CONFIG_PATH: '/fixture/openclaw.json' },
    read: async () => JSON.stringify(config),
  });
const configuration = (cleanup: unknown) => ({
  plugins: { entries: { 'agent-system': { config: { cleanup } } } },
});

describe('agent/cleanup-configuration', () => {
  it('should use sixty minutes for omitted cleanup or omitted grace', async () => {
    for (const cleanup of [undefined, {}]) {
      const current = parseCleanupConfiguration(cleanup);
      assert.equal(current.status, 'ready');
      assert.equal(current.status === 'ready' && current.graceMinutes, 60);
      const parsed = nativeSchema.safeParse!({ ...(cleanup === undefined ? {} : { cleanup }) });
      assert.equal(parsed.success, true);
      assert.deepEqual(
        await openClawCleanupConfiguration(() => ({
          plugins: { entries: { 'agent-system': { config: { cleanup } } } },
        })),
        parseCleanupConfiguration(),
      );
      assert.deepEqual(
        await codexConfiguration(configuration(cleanup)),
        parseCleanupConfiguration(),
      );
    }
    assert.deepEqual(await openClawCleanupConfiguration(() => ({})), await codexConfiguration({}));
  });

  it('should accept inclusive native grace boundaries and explicit values', async () => {
    for (const graceMinutes of [0, 17, 43200]) {
      const cleanup = { graceMinutes };
      assert.equal(nativeSchema.safeParse!({ cleanup }).success, true);
      const current = await openClawCleanupConfiguration(() => ({
        plugins: { entries: { 'agent-system': { config: { cleanup } } } },
      }));
      assert.equal(current.status === 'ready' && current.graceMinutes, graceMinutes);
      assert.deepEqual(await codexConfiguration(configuration(cleanup)), current);
    }
  });

  it('should reject invalid native settings rather than substitute the default', async () => {
    for (const cleanup of [
      null,
      false,
      [],
      60,
      '60',
      { enabled: false },
      { 'grace-minutes': 30 },
      ...[-1, 43201, 1.5, true, null, '30', []].map((graceMinutes) => ({ graceMinutes })),
    ]) {
      assert.equal(nativeSchema.safeParse!({ cleanup }).success, false);
      assert.deepEqual(parseCleanupConfiguration(cleanup), {
        status: 'blocked',
        code: 'retirement-configuration-invalid',
      });
      assert.deepEqual(
        await codexConfiguration(configuration(cleanup)),
        parseCleanupConfiguration(cleanup),
      );
      assert.deepEqual(
        await openClawCleanupConfiguration(() => configuration(cleanup)),
        parseCleanupConfiguration(cleanup),
      );
    }
    assert.equal(nativeSchema.safeParse!({ 'schema-version': 1 }).success, false);
    assert.deepEqual(
      await openClawCleanupConfiguration(() => {
        throw new Error('unavailable');
      }),
      {
        status: 'blocked',
        code: 'retirement-configuration-unavailable',
      },
    );
  });

  it('should reread changes and verify only the effective cleanup setting in both runtimes', async () => {
    const config = {
      plugins: {
        entries: {
          'agent-system': {
            config: {
              cleanup: { graceMinutes: 17 },
              collaboration: false,
            },
          },
        },
      },
    };
    const before = await openClawCleanupConfiguration(() => config);
    assert.deepEqual(await codexConfiguration(config), before);
    config.plugins.entries['agent-system'].config.collaboration = true;
    assert.deepEqual(await openClawCleanupConfiguration(() => config), before);
    assert.deepEqual(await codexConfiguration(config), before);
    config.plugins.entries['agent-system'].config.cleanup.graceMinutes = 0;
    const changed = await openClawCleanupConfiguration(() => config);
    assert.ok(before.status === 'ready' && changed.status === 'ready');
    assert.notEqual(changed.digest, before.digest);
    assert.deepEqual(await codexConfiguration(config), changed);
  });

  it('should hold malformed applicable ancestors and unresolved includes instead of defaulting', async () => {
    for (const config of [
      null,
      [],
      false,
      { plugins: null },
      { plugins: { entries: [] } },
      { plugins: { entries: { 'agent-system': false } } },
      { plugins: { entries: { 'agent-system': { config: 'invalid' } } } },
      { $include: './host.json' },
      { plugins: { $include: './plugins.json' } },
      { plugins: { entries: { 'agent-system': { config: { $include: './policy.json' } } } } },
    ]) {
      assert.deepEqual(await codexConfiguration(config), {
        status: 'blocked',
        code: 'retirement-configuration-invalid',
      });
    }
  });

  it('should read native source syntax without resolving unrelated environment, secrets or includes', async () => {
    const current = await cleanupConfiguration({
      env: { OPENCLAW_CONFIG_PATH: '/fixture/policy.json5' },
      read: async (path) => {
        assert.equal(path, '/fixture/policy.json5');
        return `// native json5 source
        {env: {SENTINEL: 'not-loaded'}, secrets: {$include: './never-read.json'},
         plugins: {entries: {'agent-system': {config: {cleanup: {graceMinutes: 17,},},},},},}`;
      },
    });
    assert.deepEqual(current, parseCleanupConfiguration({ graceMinutes: 17 }));
    assert.equal(process.env.SENTINEL, undefined);
  });

  it('should distinguish absent default configuration from unreadable or malformed selected configuration', async () => {
    const missing = async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    assert.deepEqual(
      await cleanupConfiguration({ env: { OPENCLAW_STATE_DIR: '/fixture' }, read: missing }),
      parseCleanupConfiguration(),
    );
    for (const code of ['ENOENT', 'EACCES', 'EISDIR']) {
      assert.deepEqual(
        await cleanupConfiguration({
          env: { OPENCLAW_CONFIG_PATH: '/fixture/selected.json' },
          read: async () => {
            throw Object.assign(new Error('unavailable'), { code });
          },
        }),
        { status: 'blocked', code: 'retirement-configuration-unavailable' },
      );
    }
    assert.deepEqual(await cleanupConfiguration({ env: {}, read: async () => '{broken' }), {
      status: 'blocked',
      code: 'retirement-configuration-invalid',
    });
  });
});
