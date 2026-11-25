import assert from 'node:assert/strict';

import { buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';

import {
  openClawCleanupConfiguration,
  parseCleanupConfiguration,
  projectCleanupConfiguration,
} from '../agent/cleanup-configuration.ts';
import pluginManifest from '../openclaw.plugin.json' with { type: 'json' };

const nativeSchema = buildJsonPluginConfigSchema(pluginManifest.configSchema);
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
    }
    assert.deepEqual(await openClawCleanupConfiguration(() => ({})), parseCleanupConfiguration());
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

  it('should reread changes and verify only the effective cleanup setting', async () => {
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
  });

  it('should hold malformed applicable ancestors and unresolved includes instead of defaulting', () => {
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
      assert.deepEqual(projectCleanupConfiguration(config), {
        status: 'blocked',
        code: 'retirement-configuration-invalid',
      });
    }
  });
});
