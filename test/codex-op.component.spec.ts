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
  function verifyRestart(scope: 'binding' | 'installation') {
    const check = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'test/codex-op-process-fixture.ts', data, scope],
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

  async function bind(environment: string) {
    await writeFile(
      join(workspace, 'agent.yaml'),
      'schema-version: 1\nagent: {id: example}\n' + environment,
    );
    await bindCodexWorkspace(data, workspace);
  }

  it('checks declarations for doctor and install and reuses only the enrolled binding', async () => {
    await bind('environment: {set: {LITERAL: "op://private/item/password"}}');
    assert.equal(await codexOpCredential(data, 'binding', op), undefined);
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
    const credential = (await codexOpCredential(data, 'binding', op))!;
    assert.equal((await credential.enroll()).status, 'healthy');
    verifyRestart('binding');
    const fresh = (await codexOpCredential(data, 'binding', op))!;
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
      (await (await codexOpCredential(data, 'binding', op))!.inspect()).code,
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
    const credential = (await codexOpCredential(data, 'binding', { ...op, input }))!;
    assert.equal((await credential.set('environment')).code, 'codex-op-binding-ready');
    const saved = [...entries];
    const rejected = await credential.set('environment', 'OTHER_OP_TOKEN');
    assert.equal(rejected.code, 'codex-op-binding-rejected');
    assert.doesNotMatch(JSON.stringify(rejected), /fixture-token|rejected-token/u);
    assert.deepEqual([...entries], saved);
    assert.equal((await credential.set('stdin')).code, 'codex-op-binding-ready');
    verifyRestart('binding');
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

    const credential = (await codexOpCredential(data, 'binding', op))!;
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
    const credential = (await codexOpCredential(data, 'binding', op))!;
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
      verifyRestart('binding');
      await installCodexSetup(data, undefined, options);
      const doctor = await inspectCodexSetup(data, undefined, options);
      assert.ok(doctor.findings.some((f) => f.code === 'codex-op-binding-ready'));
      assert.doesNotMatch(
        (await result.text()) + JSON.stringify(doctor),
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
    const credential = (await codexOpCredential(data, 'binding', op))!;
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
      assert.doesNotMatch(
        (await response.text()) + JSON.stringify(finding),
        /invalid-candidate|old-rejected|fixture-token/u,
      );
      assert.equal(entries.get(id!), 'old-rejected');
    }
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

  it('keeps the installation source usable after the original binding and private token are removed', async () => {
    await bind('environment: {op: [shared-id]}');
    await mkdir(join(data, 'instance'), { mode: 0o700 });
    const config = join(data, 'instance', 'config.json');
    await writeFile(
      config,
      JSON.stringify({ onePassword: { environmentId: 'shared-id', variable: 'DB_PASSWORD' } }),
      { mode: 0o600 },
    );
    const bound = (await codexOpCredential(data, 'binding', op))!;
    assert.equal((await bound.enroll()).status, 'healthy');
    const [privateKey] = entries.keys();
    const installation = (await codexOpCredential(data, 'installation', op))!;
    assert.equal((await installation.inspect()).code, 'codex-op-installation-missing');
    const missingVariable = (await codexOpCredential(data, 'installation', {
      ...op,
      createClient: async (...args) => ({
        ...(await op.createClient!(...args)),
        getVariables: async () => ({ variables: [] }),
      }),
    }))!;
    assert.equal((await missingVariable.enroll()).code, 'codex-op-installation-inaccessible');
    assert.equal(entries.size, 1);
    assert.equal((await installation.enroll()).status, 'healthy');
    entries.delete(privateKey!);
    await unbindCodexWorkspace(data);
    const restarted = (await codexOpCredential(data, 'installation', op))!;
    verifyRestart('installation');
    await assert.rejects(restarted.resolve('UNDECLARED'), /undeclared/i);
    assert.doesNotMatch(await readFile(config, 'utf8'), /fixture-token|fixture-shared-value/u);
  });

  it('validates the candidate and rechecks the binding before storing it', async () => {
    await bind('environment: {op: [shared-id]}');
    const rejected = (await codexOpCredential(data, 'binding', {
      ...op,
      input: { read: async () => ({ status: 'read', source: 'prompt', token: 'invalid' }) },
    }))!;
    assert.equal((await rejected.enroll()).code, 'codex-op-binding-rejected');
    assert.equal(entries.size, 0);
    const stale = (await codexOpCredential(data, 'binding', {
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
    const unavailable = (await codexOpCredential(data, 'binding', {
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
    const cancelled = (await codexOpCredential(data, 'binding', {
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
