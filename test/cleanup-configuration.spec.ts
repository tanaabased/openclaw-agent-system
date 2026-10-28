import assert from 'node:assert/strict';

import { buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';

import cleanupConfiguration, {
  openClawCleanupConfiguration,
  parseCleanupConfiguration,
} from '../agent/cleanup-configuration.ts';
import pluginManifest from '../openclaw.plugin.json' with { type: 'json' };

const nativeSchema = buildJsonPluginConfigSchema(pluginManifest.configSchema);

describe('agent/cleanup-configuration', () => {
  it('should use sixty minutes for omitted cleanup or omitted grace', async () => {
    for (const cleanup of [undefined, {}]) {
      const configuration = parseCleanupConfiguration(cleanup);
      assert.equal(configuration.status, 'ready');
      assert.equal(configuration.status === 'ready' && configuration.graceMinutes, 60);
      const parsed = nativeSchema.safeParse!({ ...(cleanup === undefined ? {} : { cleanup }) });
      assert.equal(parsed.success, true);
      assert.deepEqual(
        await openClawCleanupConfiguration(() => ({
          plugins: { entries: { 'agent-system': { config: { cleanup } } } },
        })),
        parseCleanupConfiguration(),
      );
    }
    assert.deepEqual(await openClawCleanupConfiguration(() => ({})), await cleanupConfiguration());
  });

  it('should accept inclusive native grace boundaries and explicit values', async () => {
    for (const graceMinutes of [0, 17, 43200]) {
      const cleanup = { graceMinutes };
      assert.equal(nativeSchema.safeParse!({ cleanup }).success, true);
      const current = await openClawCleanupConfiguration(() => ({
        plugins: { entries: { 'agent-system': { config: { cleanup } } } },
      }));
      assert.equal(current.status === 'ready' && current.graceMinutes, graceMinutes);
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

  it('should verify only the effective cleanup setting and keep standalone defaults independent', async () => {
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
    config.plugins.entries['agent-system'].config.collaboration = true;
    assert.deepEqual(await openClawCleanupConfiguration(() => config), before);
    config.plugins.entries['agent-system'].config.cleanup.graceMinutes = 0;
    const changed = await openClawCleanupConfiguration(() => config);
    assert.ok(before.status === 'ready' && changed.status === 'ready');
    assert.notEqual(changed.digest, before.digest);
    assert.equal((await cleanupConfiguration()).status, 'ready');
    assert.deepEqual(await cleanupConfiguration(), parseCleanupConfiguration({ graceMinutes: 60 }));
  });
});
