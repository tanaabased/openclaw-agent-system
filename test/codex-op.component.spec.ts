import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bindCodexWorkspace,
  unbindCodexWorkspace,
} from '../agent/identity/codex-workspace-binding.ts';
import {
  CodexSetupError,
  inspectCodexSetup,
  installCodexSetup,
} from '../agent/lifecycle/codex-setup.ts';
import { codexOpCredential } from '../credentials/codex-op.ts';
import { browserEnrollment } from '../credentials/codex-op-browser.ts';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import OpCredentialInput from '../credentials/op-input.ts';
import { opFixture } from './codex-op-process-fixture.ts';

describe('standalone codex 1password enrollment', () => {
  let root: string;
  let data: string;
  let workspace: string;
  const entries = new Map<string, string>();
  const op = opFixture(entries);
  function verifyRestart() {
    const check = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'test/codex-op-process-fixture.ts', data],
      {
        encoding: 'utf8',
        input: JSON.stringify([...entries]),
      },
    );
    assert.equal(check.status, 0, check.stderr);
    assert.equal(check.stdout, '');
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-op-'));
    workspace = join(root, 'workspace');
    data = join(root, 'data');
    await mkdir(workspace);
    entries.clear();
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  async function bind(environment: string, agentId = 'example') {
    await writeFile(
      join(workspace, 'agent.yaml'),
      `schema-version: 1\nagent: {id: ${agentId}}\n` + environment,
    );
    await bindCodexWorkspace(data, workspace);
  }

  it('checks declarations for doctor and install and reuses only the enrolled binding', async () => {
    await bind('environment: {set: {LITERAL: "op://private/item/password"}}');
    assert.equal(await codexOpCredential(data, op), undefined);
    const declaration = 'environment: {set: {PRIVATE: {from-op: "op://private/item/password"}}}';
    await bind(`${declaration}
setup-agent:
  steps:
    - id: codex-config
      runtimes: [codex]
      check: test -f .codex-config-ready
      apply: touch .codex-config-ready
`);
    const options = { op, baseEnvironment: { HOME: root, PATH: '/usr/bin:/bin' } };
    const doctor = () => inspectCodexSetup(data, undefined, options);
    const before = await doctor();
    assert.ok(before.findings.some((f) => f.code === 'codex-op-binding-missing'));
    assert.equal(before.findings.find((f) => f.stepId === 'codex-config')?.status, 'drift');
    await assert.rejects(installCodexSetup(data, undefined, options), (error: unknown) => {
      assert.ok(error instanceof CodexSetupError);
      assert.equal(error.code, 'codex-op-binding-missing');
      assert.ok(
        error.partialInstall?.outcomes.some(
          ({ stepId, code }) => stepId === 'codex-config' && code === 'setup-applied',
        ),
      );
      return true;
    });
    const after = await doctor();
    assert.ok(after.findings.some((f) => f.code === 'codex-op-binding-missing'));
    assert.equal(after.findings.find((f) => f.stepId === 'codex-config')?.status, 'healthy');
    assert.equal(entries.size, 0);
    const credential = (await codexOpCredential(data, op))!;
    assert.equal((await credential.enroll()).status, 'healthy');
    verifyRestart();
    const fresh = (await codexOpCredential(data, op))!;
    const reports = JSON.stringify([
      await doctor(),
      await installCodexSetup(data, undefined, options),
    ]);
    assert.match(reports, /codex-op-binding-ready/u);
    assert.doesNotMatch(reports, /fixture-token|fixture-private-value/u);
    for (const id of entries.keys()) entries.set(id, 'rejected-token');
    assert.equal((await fresh.inspect()).code, 'codex-op-binding-rejected');
    assert.equal((await fresh.enroll()).status, 'healthy');
    await unbindCodexWorkspace(data);
    await bind(declaration);
    assert.equal(
      (await (await codexOpCredential(data, op))!.inspect()).code,
      'codex-op-binding-missing',
    );
    await assert.rejects(fresh.resolve('PRIVATE'), /changed/u);
  });

  it('validates explicit noninteractive input before replacing a bound credential', async () => {
    await bind('environment: {set: {PRIVATE: {from-op: "op://private/item/password"}}}');
    const input = new OpCredentialInput({
      hostEnvironment: {
        OP_SERVICE_ACCOUNT_TOKEN: 'fixture-token',
        OTHER_OP_TOKEN: 'rejected-token',
      },
      input: Readable.from(['fixture-token\n']),
      output: process.stderr,
    });
    const credential = (await codexOpCredential(data, { ...op, input }))!;
    assert.equal((await credential.set('environment')).code, 'codex-op-binding-ready');
    const saved = [...entries];
    const rejected = await credential.set('environment', 'OTHER_OP_TOKEN');
    assert.equal(rejected.code, 'codex-op-binding-rejected');
    assert.doesNotMatch(JSON.stringify(rejected), /fixture-token|rejected-token/u);
    assert.deepEqual([...entries], saved);
    assert.equal((await credential.set('stdin')).code, 'codex-op-binding-ready');
    verifyRestart();
  });

  it('should export resolved values through standalone install using the enrolled binding', async () => {
    await writeFile(join(workspace, 'shell.env'), 'DB_PASSWORD=dotenv-value\n');
    await bind(`environment:
  dotenv: shell.env
  op: shared-id
  set:
    DB_PASSWORD: set-value
    PRIVATE: {from-op: 'op://private/item/password'}
  export:
    variables: [DB_PASSWORD]
    path: export.sh
`);
    const options = {
      op,
      baseEnvironment: { HOME: root, OP_SERVICE_ACCOUNT_TOKEN: 'fixture-token' },
    };
    const path = join(await realpath(workspace), 'export.sh');
    const before = await inspectCodexSetup(data, undefined, options);
    assert.ok(before.findings.some(({ code }) => code === 'environment-export-missing'));
    await assert.rejects(installCodexSetup(data, undefined, options), {
      code: 'codex-op-binding-missing',
    });
    await assert.rejects(access(path), { code: 'ENOENT' });

    const credential = (await codexOpCredential(data, op))!;
    assert.equal((await credential.enroll()).status, 'healthy');
    const installed = await installCodexSetup(data, undefined, options);
    assert.ok(
      installed.outcomes.some(
        ({ code, message }) => code === 'environment-export-created' && message === path,
      ),
    );
    const child = spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-ec',
        '. "$1"; "$2" -e \'console.log(JSON.stringify([process.env.DB_PASSWORD, process.env.PRIVATE, process.env.OP_SERVICE_ACCOUNT_TOKEN]))\'',
        'bash',
        path,
        process.execPath,
      ],
      { env: {}, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), ['fixture-shared-value', null, null]);
    const after = await inspectCodexSetup(data, undefined, options);
    assert.ok(after.findings.some(({ code }) => code === 'environment-export-ready'));
    assert.doesNotMatch(
      JSON.stringify([installed, after]),
      /fixture-(?:token|private-value|shared-value)/u,
    );

    const snapshot = await readFile(path, 'utf8');
    assert.doesNotMatch(snapshot, /fixture-(?:token|private-value)|dotenv-value|set-value/u);
    entries.clear();
    await assert.rejects(installCodexSetup(data, undefined, options), {
      code: 'codex-op-binding-missing',
    });
    assert.equal(await readFile(path, 'utf8'), snapshot);
  });

  it('connects through the local page and verifies stored access before continuing Install', async () => {
    await bind(
      'environment: {op: [shared-id], set: {PRIVATE: {from-op: "op://private/item/password"}}}',
    );
    const credential = (await codexOpCredential(data, op))!;
    const options = { op, baseEnvironment: { HOME: root, PATH: '/usr/bin:/bin' } };
    for (const action of ['save', 'import']) {
      entries.clear();
      const opened = Promise.withResolvers<string>();
      const env = action === 'import' ? { OP_SERVICE_ACCOUNT_TOKEN: 'fixture-token' } : {};
      const completed = credential.enrollInBrowser(opened.resolve, env);
      const url = await Promise.race([
        opened.promise,
        completed.then((finding) => assert.fail(finding.code)),
      ]);
      const page = await fetch(url);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      const html = await page.text();
      const nonce = /<script nonce="([^"]+)"/u.exec(html)?.[1];
      assert.ok(nonce);
      assert.ok(
        page.headers.get('content-security-policy')?.includes(`script-src 'nonce-${nonce}'`),
      );
      assert.ok(
        html.includes(workspace) &&
          html.includes('shared-id') &&
          html.includes('op://private/item/password'),
      );
      assert.equal(html.includes('value="import"'), action === 'import');
      assert.doesNotMatch(html + url, /fixture-token|fixture-(private|shared)-value/u);
      const body = new URLSearchParams(
        action === 'import' ? { action } : { action, token: 'fixture-token' },
      );
      assert.equal(
        (await fetch(url, { method: 'POST', headers: { origin: 'https://other.invalid' }, body }))
          .status,
        403,
      );
      assert.equal(entries.size, 0);
      const result = await fetch(url, {
        method: 'POST',
        headers: { origin: new URL(url).origin },
        body,
      });
      assert.equal(result.status, 200);
      assert.equal((await completed).code, 'codex-op-binding-ready');
      verifyRestart();
      await installCodexSetup(data, undefined, options);
      const doctor = await inspectCodexSetup(data, undefined, options);
      assert.ok(doctor.findings.some((f) => f.code === 'codex-op-binding-ready'));
      const screen = await result.text();
      assert.match(screen, /<h1>1Password connected<\/h1>/u);
      assert.doesNotMatch(
        screen + JSON.stringify(doctor),
        /fixture-token|fixture-(private|shared)-value/u,
      );
    }
    assert.equal(
      (await credential.enrollInBrowser(() => assert.fail('already enrolled'))).status,
      'healthy',
    );
  });

  it('keeps the prior credential on cancellation and rejected import', async () => {
    await bind('environment: {op: [shared-id]}');
    const credential = (await codexOpCredential(data, op))!;
    await credential.enroll();
    const [id] = entries.keys();
    entries.set(id!, 'old-rejected');
    for (const action of ['cancel', 'import']) {
      const opened = Promise.withResolvers<string>();
      const completed = credential.enrollInBrowser(opened.resolve, {
        OP_SERVICE_ACCOUNT_TOKEN: 'invalid-candidate',
      });
      const url = await Promise.race([
        opened.promise,
        completed.then((finding) => assert.fail(finding.code)),
      ]);
      const response = await fetch(url, {
        method: 'POST',
        headers: { origin: new URL(url).origin },
        body: new URLSearchParams({ action }),
      });
      const finding = await completed;
      assert.equal(
        finding.code,
        action === 'cancel' ? 'op-credential-input-cancelled' : 'codex-op-binding-rejected',
      );
      const screen = await response.text();
      assert.ok(screen.includes(action === 'cancel' ? 'Connection cancelled' : 'Token rejected'));
      assert.doesNotMatch(
        screen + JSON.stringify(finding),
        /invalid-candidate|old-rejected|fixture-token/u,
      );
      assert.equal(entries.get(id!), 'old-rejected');
    }
  });

  it('keeps candidate rejection, a refused save and unconfirmed readback distinct', async () => {
    await bind('environment: {op: [shared-id]}');
    for (const scenario of [
      { name: 'access', title: 'More access needed', writes: 0 },
      { name: 'refused', title: 'Token could not be saved', writes: 1 },
      { name: 'readback', title: 'Save could not be confirmed', writes: 1 },
    ]) {
      let writes = 0;
      const fixtureStore = op.store!;
      const credential = (await codexOpCredential(data, {
        ...op,
        store: {
          ...fixtureStore,
          async write(key, token) {
            writes += 1;
            if (scenario.name === 'refused') {
              return {
                status: 'unavailable',
                code: 'credential-keychain-write-failed',
                message: 'fixture-private-error',
              };
            }
            return fixtureStore.write(key, token);
          },
          async read(key) {
            if (scenario.name === 'readback' && writes) return { status: 'missing' };
            return fixtureStore.read(key);
          },
        },
        async createClient(...args) {
          const client = await op.createClient!(...args);
          if (scenario.name !== 'access') return client;
          return {
            ...client,
            async getVariables() {
              throw Object.assign(new Error('fixture-private-error'), { httpStatus: 403 });
            },
          };
        },
      }))!;
      const opened = Promise.withResolvers<string>();
      const completed = credential.enrollInBrowser(opened.resolve);
      const url = await Promise.race([opened.promise, completed.then((f) => assert.fail(f.code))]);
      const response = await fetch(url, {
        method: 'POST',
        headers: { origin: new URL(url).origin },
        body: new URLSearchParams({ action: 'save', token: 'fixture-token' }),
      });
      const finding = await completed;
      const screen = await response.text();
      assert.equal(finding.status, 'blocked');
      assert.equal(writes, scenario.writes);
      assert.ok(screen.includes(`<h1>${scenario.title}</h1>`));
      assert.doesNotMatch(screen, /fixture-token|fixture-private-error/u);
      if (scenario.name === 'readback') assert.match(screen, /Run Doctor.*before trying again/u);
    }
  });

  it('keeps one submission in flight and refuses a duplicate and cancellation', async () => {
    const opened = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let saves = 0;
    const completed = browserEnrollment({
      label: 'workspace <fixture>',
      requirements: { environmentIds: [], secrets: [] },
      onReady: opened.resolve,
      async save() {
        saves += 1;
        started.resolve();
        await finish.promise;
        return {
          screen: 'connected',
          finding: {
            component: 'credentials',
            status: 'healthy',
            code: 'fixture-ready',
            message: 'ready',
          },
        };
      },
    });
    const url = await Promise.race([opened.promise, completed.then((f) => assert.fail(f.code))]);
    const post = (action: string) =>
      fetch(url, {
        method: 'POST',
        headers: { origin: new URL(url).origin },
        body: new URLSearchParams({ action, token: 'fixture-token' }),
      });
    const first = post('save');
    try {
      await started.promise;
      const responses = await Promise.all([post('save'), post('cancel')]);
      for (const response of responses) {
        assert.equal(response.status, 409);
        const screen = await response.text();
        assert.match(screen, /workspace &lt;fixture&gt;/u);
        assert.doesNotMatch(screen, /fixture-token/u);
      }
      assert.equal(saves, 1);
    } finally {
      finish.resolve();
    }
    assert.match(await (await first).text(), /<h1>1Password connected<\/h1>/u);
    assert.equal((await completed).code, 'fixture-ready');
  });

  it('expires an unused local link without saving', async () => {
    let url = '';
    const result = await browserEnrollment({
      label: 'workspace',
      requirements: { environmentIds: [], secrets: [] },
      onReady: (ready) => {
        url = ready;
      },
      timeoutMs: 30,
      save: () => assert.fail('unexpected save'),
    });
    assert.equal(result.code, 'op-credential-input-expired');
    await assert.rejects(fetch(url));
  });

  it('uses only the new binding for shared values after a switch and reports missing grants', async () => {
    const declarations =
      'environment: {op: [shared-id], set: {PRIVATE: {from-op: "op://private/item/password"}}}';
    await bind(declarations);
    const previous = (await codexOpCredential(data, op))!;
    assert.equal((await previous.enroll()).status, 'healthy');
    assert.equal(await previous.resolve('DB_PASSWORD'), 'fixture-shared-value');

    await unbindCodexWorkspace(data);
    await assert.rejects(codexOpCredential(data, op), /binding is required/u);
    workspace = join(root, 'replacement');
    await mkdir(workspace);
    await bind(declarations, 'replacement');
    const replacement = (await codexOpCredential(data, {
      ...op,
      input: {
        read: async () => ({ status: 'read', source: 'prompt', token: 'replacement-token' }),
      },
      createClient: async (token) => {
        assert.equal(token, 'replacement-token');
        return op.createClient!('fixture-token', 'test');
      },
    }))!;
    assert.equal((await replacement.inspect()).code, 'codex-op-binding-missing');
    await assert.rejects(replacement.resolve('DB_PASSWORD'), /missing/u);
    await assert.rejects(previous.resolve('DB_PASSWORD'), /changed/u);
    assert.equal((await replacement.enroll()).status, 'healthy');
    assert.equal(entries.size, 2);
    const requested: string[] = [];
    const denied = (await codexOpCredential(data, {
      ...op,
      createClient: async (token, version) => {
        // The old token still has access. A fallback would incorrectly succeed.
        if (token === 'fixture-token') return op.createClient!(token, version);
        assert.equal(token, 'replacement-token');
        return {
          async getVariables(id) {
            requested.push(id);
            throw Object.assign(new Error('forbidden'), { httpStatus: 403 });
          },
          resolveSecret: () => assert.fail('an unrelated secret was requested'),
        };
      },
    }))!;
    await assert.rejects(denied.resolve('DB_PASSWORD'), /grants/u);
    assert.deepEqual(requested, ['shared-id']);
  });

  it('validates the candidate and rechecks the binding before storing it', async () => {
    await bind('environment: {op: [shared-id]}');
    const rejected = (await codexOpCredential(data, {
      ...op,
      input: { read: async () => ({ status: 'read', source: 'prompt', token: 'invalid' }) },
    }))!;
    assert.equal((await rejected.enroll()).code, 'codex-op-binding-rejected');
    assert.equal(entries.size, 0);
    const stale = (await codexOpCredential(data, {
      ...op,
      createClient: async (...args) => {
        await unbindCodexWorkspace(data);
        return op.createClient!(...args);
      },
    }))!;
    await assert.rejects(stale.enroll(), /binding/i);
    assert.equal(entries.size, 0);
  });

  it('leaves unavailable stores and cancelled enrollment untouched', async () => {
    await bind('environment: {op: [shared-id]}');
    const unavailable = (await codexOpCredential(data, {
      ...op,
      store: {
        ...op.store!,
        read: async () => ({ status: 'unavailable', code: 'locked', message: 'locked' }),
      },
      input: {
        read: async () => {
          throw new Error('unexpected prompt');
        },
      },
    }))!;
    assert.equal((await unavailable.enroll()).code, 'codex-op-binding-inaccessible');
    const cancelled = (await codexOpCredential(data, {
      ...op,
      input: {
        read: async () => ({
          status: 'invalid',
          code: 'op-credential-input-cancelled',
          message: 'cancelled',
        }),
      },
    }))!;
    assert.equal((await cancelled.enroll()).code, 'op-credential-input-cancelled');
    assert.equal(entries.size, 0);
  });
});
