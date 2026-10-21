import assert from 'node:assert/strict';

import cleanupConfiguration from '../agent/cleanup-configuration.ts';
import readInstallationConfig, { parseInstallationConfig } from '../core/installation-config.ts';
import installationConfigRoot from '../core/installation-config-root.ts';
import type { AgentManifest } from '../manifest/types.ts';

const path = '/config/tanaab/agent-system/config.yaml';
const manifest: AgentManifest = { schemaVersion: 1, agent: { id: 'first' } };

describe('core/installation-config', () => {
  it('should select the trusted absolute installation root independently of runtime paths', () => {
    assert.equal(
      installationConfigRoot({ XDG_CONFIG_HOME: '/config', HOME: '/home', CODEX_HOME: '/other' }),
      '/config/tanaab/agent-system',
    );
    assert.equal(installationConfigRoot({ HOME: '/home' }), '/home/.config/tanaab/agent-system');
    assert.equal(installationConfigRoot({ XDG_CONFIG_HOME: 'relative', HOME: '/home' }), undefined);
    assert.equal(installationConfigRoot({ HOME: 'relative' }), undefined);
    assert.equal(installationConfigRoot({}), undefined);
  });

  it('should default only missing files or omitted grace settings to sixty minutes', () => {
    for (const source of [undefined, 'schema-version: 1', 'schema-version: 1\ncleanup: {}']) {
      const parsed = parseInstallationConfig(source, path);
      assert.equal(parsed.status, 'ready');
      if (parsed.status !== 'ready') throw new Error('not ready');
      assert.equal(parsed.graceMinutes, 60);
      assert.equal(parsed.source, 'default');
    }
  });

  it('should accept the inclusive grace boundaries without an enable switch', () => {
    for (const minutes of [0, 17, 43200]) {
      const parsed = parseInstallationConfig(
        `schema-version: 1\ncleanup: {grace-minutes: ${minutes}}`,
        path,
      );
      assert.equal(parsed.status, 'ready');
      if (parsed.status !== 'ready') throw new Error('not ready');
      assert.equal(parsed.graceMinutes, minutes);
      assert.equal(parsed.source, 'file');
      assert.equal(parsed.path, path);
    }
  });

  it('should hold malformed, unsupported and unknown settings instead of using a fallback', () => {
    for (const source of [
      '',
      '{}',
      'schema-version: 2',
      'schema-version: 1\nunknown: true',
      'schema-version: 1\ncleanup: {enabled: false}',
      ...['-1', '43201', '1.5', 'true', 'null', '"30"', '[]'].map(
        (value) => `schema-version: 1\ncleanup: {grace-minutes: ${value}}`,
      ),
      'schema-version: 1\ncleanup: &cleanup {}',
      'schema-version: 1\nschema-version: 1',
    ])
      assert.deepEqual(parseInstallationConfig(source, path), {
        status: 'blocked',
        path,
        code: 'retirement-configuration-invalid',
      });
  });

  it('should reread one installation file across agents and distinct host runtime directories', async () => {
    let source = 'schema-version: 1\ncleanup: {grace-minutes: 23}';
    const paths: string[] = [];
    const read = async (requested: string) => {
      paths.push(requested);
      return source;
    };
    const openclaw = () =>
      readInstallationConfig({ XDG_CONFIG_HOME: '/config', CODEX_HOME: '/ignored-one' }, read);
    const codex = () =>
      readInstallationConfig({ XDG_CONFIG_HOME: '/config', CODEX_HOME: '/ignored-two' }, read);
    const first = await cleanupConfiguration(manifest, openclaw);
    assert.deepEqual(
      await cleanupConfiguration({ ...manifest, agent: { id: 'second' } }, codex),
      first,
    );
    source = 'schema-version: 1\ncleanup: {grace-minutes: 0}';
    const changed = await cleanupConfiguration(manifest, codex);
    assert.equal(changed.status === 'ready' && changed.graceMinutes, 0);
    assert.notDeepEqual(changed, first);
    assert.deepEqual(paths, [path, path, path]);
  });

  it('should hold unavailable roots and read failures without resolving declared secrets', async () => {
    assert.equal((await readInstallationConfig({})).status, 'blocked');
    const result = await readInstallationConfig({ XDG_CONFIG_HOME: '/config' }, async () => {
      throw new Error('access denied');
    });
    assert.deepEqual(result, {
      status: 'blocked',
      path,
      code: 'retirement-configuration-unavailable',
    });
    const pending = await cleanupConfiguration(
      { ...manifest, environment: { op: ['never-resolve'] } },
      async () => result,
    );
    assert.deepEqual(pending, result);
  });

  it('should hold every explicit legacy block without selecting one agents old timing', async () => {
    for (const declaration of [
      {},
      { enabled: true },
      { enabled: false },
      { 'grace-minutes': 60 },
      { 'grace-minutes': 17 },
    ]) {
      const legacy = await cleanupConfiguration(
        { ...manifest, cleanupMigration: { declaration } },
        async () => parseInstallationConfig(undefined, path),
      );
      assert.equal(legacy.status, 'blocked');
      assert.equal(
        legacy.status === 'blocked' && legacy.code,
        'retirement-cleanup-migration-required',
      );
    }
    assert.equal(
      (await cleanupConfiguration(manifest, async () => parseInstallationConfig(undefined, path)))
        .status,
      'ready',
    );
  });
});
