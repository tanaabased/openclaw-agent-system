import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// ci-only: the native host runs packaged hooks; a local endpoint observes its model input.
const [pluginRoot, pluginData, home] = process.argv.slice(2);
await mkdir(home, { recursive: true });
const runtime = join(pluginRoot, 'dist/codex/codex-runtime.js');
const captured = [];
const endpoint = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.url.endsWith('/responses')) captured.push(JSON.parse(body));
  response.writeHead(400, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({ error: { message: 'fixture stops after inspecting model input' } }),
  );
});
endpoint.listen(0, '127.0.0.1');
await once(endpoint, 'listening');
const packaged = JSON.parse(await readFile(join(pluginRoot, 'hooks/hooks.json'), 'utf8'));
await writeFile(
  join(home, 'hooks.json'),
  JSON.stringify({
    hooks: Object.fromEntries(
      ['SessionStart', 'UserPromptSubmit'].map((name) => [name, packaged.hooks[name]]),
    ),
  }),
);
await writeFile(
  join(home, 'config.toml'),
  [
    'model = "fixture"',
    'model_provider = "fixture"',
    '[model_providers.fixture]',
    'name = "native context fixture"',
    `base_url = "http://127.0.0.1:${endpoint.address().port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
  ].join('\n'),
);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  CODEX_HOME: home,
  PLUGIN_ROOT: pluginRoot,
  PLUGIN_DATA: pluginData,
};
const child = spawn('codex', ['--no-daemon', 'app-server', '--stdio'], {
  cwd: home,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let sequence = 0,
  buffer = '',
  stderr = '';
const pending = new Map();
const events = [];
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let index; (index = buffer.indexOf('\n')) >= 0;) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    const receive = pending.get(message.id);
    if (receive) {
      pending.delete(message.id);
      receive(message);
    } else events.push(message);
  }
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`native request timed out: ${method}\n${stderr}`));
    }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
try {
  await request('initialize', {
    clientInfo: { name: 'agent-system-native-context-fixture', version: '1' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  const inventory = await request('hooks/list', { cwds: [home] });
  for (const hook of inventory.data[0].hooks) {
    // trust only these fixture-owned copies inside the disposable ci home.
    assert.equal(hook.sourcePath, join(home, 'hooks.json'));
    await request('config/value/write', {
      keyPath: 'hooks.state.' + JSON.stringify(hook.key),
      value: {
        enabled: true,
        trusted_hash: hook.currentHash,
        trusted_content_hash: hook.currentHash,
      },
      mergeStrategy: 'replace',
    });
  }
  for (const kind of ['ordinary', 'delegated']) {
    const { thread } = await request('thread/start', {
      cwd: home,
      model: 'fixture',
      modelProvider: 'fixture',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      experimentalRawEvents: true,
    });
    for (const name of kind === 'ordinary'
      ? ['ordinary']
      : ['create_thread', 'send_message_to_thread']) {
      const before = captured.length;
      const { turn } = await request('turn/start', {
        threadId: thread.id,
        input:
          kind === 'ordinary'
            ? [{ type: 'text', text: 'Inspect context only.', text_elements: [] }]
            : [],
        ...(kind === 'delegated'
          ? {
              toolOutput: {
                name,
                namespace: 'codex_app',
                output: 'Inspect context only.',
                retain: true,
              },
            }
          : {}),
      });
      const deadline = Date.now() + 20000;
      while (
        !events.some(
          (event) => event.method === 'turn/completed' && event.params.turn.id === turn.id,
        )
      ) {
        assert.ok(Date.now() < deadline, `native turn did not finish: ${stderr}`);
        await delay(20);
      }
      assert.ok(captured.length > before, `no model input observed for ${name}: ${stderr}`);
      const input = JSON.stringify(captured[before]);
      assert.ok(input.includes('turnContextRuntime'), `${name}: missing private recovery context`);
      if (kind === 'ordinary') {
        assert.ok(input.includes('contextProbe'), 'ordinary input skipped the per-turn hook');
        assert.ok(input.includes(turn.id), 'per-turn context is not current');
      }
      const lookup = spawnSync(
        process.execPath,
        [runtime, 'turn-context', '--plugin-data', pluginData],
        {
          env: { ...env, CODEX_THREAD_ID: thread.id },
          input: '',
          encoding: 'utf8',
          timeout: 20000,
        },
      );
      assert.equal(lookup.status, 0, lookup.stderr || lookup.error?.message);
      assert.equal(JSON.parse(lookup.stdout).status, 'unmanaged-turn');
      process.stdout.write(
        `${name}: private context reached the model boundary; read-only native lookup available\n`,
      );
    }
  }
} finally {
  child.kill();
  await exited;
  endpoint.close();
}
