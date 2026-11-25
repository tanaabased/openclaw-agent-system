import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bindCodexWorkspace,
  unbindCodexWorkspace,
} from '../agent/identity/codex-workspace-binding.ts';
import { inspectCodexSetup, installCodexSetup } from '../agent/lifecycle/codex-setup.ts';
import { codexOpCredential } from '../credentials/codex-op.ts';
import { spawnSync } from 'node:child_process';
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
    await bind(declaration);
    const options = { op, baseEnvironment: { HOME: root, PATH: '/usr/bin:/bin' } };
    const doctor = () => inspectCodexSetup(data, undefined, options);
    assert.ok((await doctor()).findings.some((f) => f.code === 'codex-op-binding-missing'));
    await assert.rejects(installCodexSetup(data, undefined, options), {
      code: 'codex-op-binding-missing',
    });
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
