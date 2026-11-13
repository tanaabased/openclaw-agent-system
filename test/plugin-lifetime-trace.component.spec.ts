import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const preload = path.resolve('scripts/plugin-lifetime-trace.mjs');

describe('scripts/plugin-lifetime-trace', () => {
  function run(source: string, name: string, body: string) {
    const root = mkdtempSync(path.join(tmpdir(), 'lifetime-trace-'));
    try {
      const dist = path.join(root, 'openclaw', 'dist');
      mkdirSync(dist, { recursive: true });
      const module = path.join(dist, name);
      writeFileSync(module, source);
      return spawnSync(
        process.execPath,
        [
          '--import',
          preload,
          '--input-type=module',
          '-e',
          `const mod = await import(${JSON.stringify(pathToFileURL(module).href)}); ${body}`,
        ],
        { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' } },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('should retain the rejection and capture frames without its private message', () => {
    const result = run(
      'export class Unavailable extends Error { constructor() { super("private-provider-detail"); this.name = "PluginInstanceUnavailableError"; } }',
      'plugin-cache-fixture.mjs',
      'try { throw new mod.Unavailable(); } catch (error) { if (error.message !== "private-provider-detail") process.exit(2); process.exitCode = 7; }',
    );
    assert.equal(result.status, 7, result.stderr);
    assert.match(result.stderr, /instance-unavailable/);
    assert.match(result.stderr, /plugin-cache-fixture\.mjs/);
    assert.doesNotMatch(result.stderr, /private-provider-detail/);
    const events = result.stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
    assert.ok(events.find(({ event }) => event === 'instance-unavailable').stack.length > 0);
  });

  it('should distinguish publication from finished cleanup without changing the result', () => {
    const result = run(
      `export async function reloadGatewayPlugins() {
        const params = {}; const randomUUID = () => 'fixture-operation';
        const getPluginRuntimeGeneration = () => 3;
        const operationId = params.pluginLifecycle?.operationId ?? randomUUID();
        const changedPluginIds = new Set(['fixture']); const log = {info() {}};
        log.info(\`Plugin replacement applied: \${[...changedPluginIds].join(", ")}\`);
        const phase = 'dispose', committed = true, restored = false;
        const recovery = {async dispose() { process.stdout.write('cleanup\\n'); }};
        await recovery.dispose();
        return 'original-result';
      }`,
      'server-plugin-reload-fixture.mjs',
      'if (await mod.reloadGatewayPlugins() !== "original-result") process.exit(2);',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'cleanup\n');
    const events = result.stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
    assert.deepEqual(
      events.filter(({ event }) => event !== 'instrumented').map(({ event }) => event),
      ['reload-start', 'reload-published', 'reload-finished'],
    );
    assert.equal(events.at(-1).committed, true);
    assert.equal(events.at(-1).generation, 3);
  });

  it('should reject an unmatched build instead of implying diagnostic coverage', () => {
    const result = run(
      'export class PluginInstanceUnavailableError extends Error {}',
      'plugin-cache-fixture.mjs',
      '',
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /instrumentation does not match/);
  });
});
