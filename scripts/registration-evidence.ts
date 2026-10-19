import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const string = (value: unknown) => (typeof value === 'string' ? value : null);
const agents = (value: unknown) =>
  Array.isArray(value)
    ? value.map((entry) => ({
        id: string(object(entry).id),
        workspace: string(object(entry).workspace),
      }))
    : null;

/** CI-only observation: never emit complete config, identities, or raw RPC errors. */
export default function registrationEvidence(input: {
  configPath: string;
  read(): { text: string; ino: number; mtimeMs: number; size: number };
  request(method: string): unknown;
}) {
  function observe(read: () => unknown) {
    try {
      return { status: 'observed', value: read() };
    } catch {
      return { status: 'unavailable' };
    }
  }
  return {
    saved: observe(() => {
      const { text, ...file } = input.read();
      const config = object(JSON.parse(text));
      return {
        path: input.configPath,
        ...file,
        agents: agents(object(config.agents).list),
        reloadMode: string(object(object(config.gateway).reload).mode),
      };
    }),
    // config.get can be cached by the watcher. It is not the running agent list.
    gatewaySnapshot: observe(() => {
      const snapshot = object(input.request('config.get'));
      return {
        path: string(snapshot.path),
        valid: typeof snapshot.valid === 'boolean' ? snapshot.valid : null,
        configRevisionHash: string(snapshot.configRevisionHash),
        appliedConfigHash: string(snapshot.appliedConfigHash),
        agents: agents(object(object(snapshot.config).agents).list),
      };
    }),
    runningAgents: observe(() => agents(object(input.request('agents.list')).agents)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions only.');
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? '';
  const evidence = registrationEvidence({
    configPath,
    read() {
      const { ino, mtimeMs, size } = statSync(configPath);
      return { text: readFileSync(configPath, 'utf8'), ino, mtimeMs, size };
    },
    request(method) {
      const result = spawnSync(
        'openclaw',
        ['gateway', 'call', method, '--params', '{}', '--timeout', '5000', '--json'],
        { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      assert.equal(result.status, 0);
      return JSON.parse(result.stdout);
    },
  });
  process.stderr.write(
    JSON.stringify({
      registrationEvidence: process.argv[2],
      observedAt: new Date().toISOString(),
      cwd: process.cwd(),
      profile: process.env.OPENCLAW_PROFILE,
      stateDir: process.env.OPENCLAW_STATE_DIR,
      ...evidence,
    }) + '\n',
  );
}
