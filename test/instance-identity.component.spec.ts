import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import AssignmentClaimStore from '../agent/assignment-claim-store.ts';
import instanceIdentity, { operateInstanceIdentity } from '../agent/instance-identity.ts';
import { inspectCodexSetup, installCodexSetup } from '../agent/codex-setup.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { codexInstanceStore } from '../agent/codex-assignment-claims.ts';
import AgentSystemLifecycleRegistry from '../core/lifecycle-registry.ts';
import instanceCommand from '../cli/instance.ts';
import { createCliStyles } from '../cli/output.ts';

describe('agent/instance-identity', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'instance-identity-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should keep doctor read-only and preserve identity through repeated openclaw install', async () => {
    const store = new AssignmentClaimStore(join(root, 'instance'));
    const registry = new AgentSystemLifecycleRegistry([instanceIdentity(store)]);
    const context = {
      manifest: { schemaVersion: 1 as const, agent: { id: 'receiver' } },
      workspaceDir: root,
      runtime: 'openclaw' as const,
    };
    assert.equal((await registry.inspect(context))[0]!.code, 'instance-identity-missing');
    await assert.rejects(access(store.root), { code: 'ENOENT' });
    assert.equal((await registry.reconcile(context)).outcomes[0]!.status, 'created');
    const identity = await store.inspect();
    assert.match(identity!.instanceId, /^[a-f0-9-]{36}$/u);
    assert.match(identity!.displayName, /^[a-z]+-[a-z]+$/u);
    const before = await readFile(join(store.root, 'assignment-claims.json'), 'utf8');
    assert.equal((await registry.inspect(context))[0]!.status, 'healthy');
    assert.equal((await registry.reconcile(context)).outcomes[0]!.status, 'unchanged');
    assert.equal(await readFile(join(store.root, 'assignment-claims.json'), 'utf8'), before);
  });

  it('should initialize standalone identity only through install and preserve it across workspace rebinding', async () => {
    const pluginData = join(root, 'plugin');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'agent.yaml'), 'schema-version: 1\nagent: {id: receiver}\n');
    await bindCodexWorkspace(pluginData, workspace);
    const deps = { codexHome: join(root, 'codex') };
    const inspection = await inspectCodexSetup(pluginData, undefined, deps);
    assert.ok(inspection.findings.some((f) => f.code === 'instance-identity-missing'));
    const store = codexInstanceStore(pluginData);
    assert.equal(await store.inspect(), undefined);
    await installCodexSetup(pluginData, undefined, deps);
    const saved = await store.inspect();
    const replacement = join(root, 'replacement');
    await mkdir(replacement);
    await writeFile(
      join(replacement, 'agent.yaml'),
      'schema-version: 1\nagent: {id: replacement}\n',
    );
    await bindCodexWorkspace(pluginData, replacement);
    await installCodexSetup(pluginData, undefined, deps);
    assert.deepEqual(await store.inspect(), saved);
  });

  it('should rename without rotating and reject repeated rotation using a stale id', async () => {
    const store = new AssignmentClaimStore(join(root, 'instance'));
    await assert.rejects(
      operateInstanceIdentity(store, 'rename', { name: 'My Laptop' }),
      /instance-install-required/u,
    );
    const before = await store.identity();
    const renamed = await operateInstanceIdentity(store, 'rename', { name: 'My Laptop' });
    assert.deepEqual(renamed, {
      status: 'renamed',
      instanceId: before.instanceId,
      displayName: 'my-laptop',
    });
    const rotated = await operateInstanceIdentity(store, 'rotate', {
      expectedInstanceId: before.instanceId,
    });
    assert.equal('displayName' in rotated && rotated.displayName, 'my-laptop');
    assert.notEqual('instanceId' in rotated && rotated.instanceId, before.instanceId);
    await assert.rejects(
      operateInstanceIdentity(store, 'rotate', { expectedInstanceId: before.instanceId }),
      /instance-rotation-stale/u,
    );
    await assert.rejects(
      operateInstanceIdentity(store, 'rename', { name: 'another', instanceId: before.instanceId }),
      /instance-request-invalid/u,
    );
  });

  it('should report corrupt identity without replacing it during install', async () => {
    const store = new AssignmentClaimStore(join(root, 'instance'));
    await store.identity();
    const path = join(store.root, 'assignment-claims.json');
    await writeFile(path, '{broken');
    const lifecycle = instanceIdentity(store);
    const context = {
      manifest: { schemaVersion: 1 as const, agent: { id: 'receiver' } },
      workspaceDir: root,
    };
    assert.equal((await lifecycle.inspect!(context))[0]!.code, 'instance-identity-invalid');
    await assert.rejects(lifecycle.reconcile!(context));
    assert.equal(await readFile(path, 'utf8'), '{broken');
  });

  it('should mask human identity output while preserving the full json receipt', async () => {
    const store = new AssignmentClaimStore(join(root, 'instance'));
    const identity = await store.identity();
    let stdout = '',
      stderr = '';
    const options = {
      store,
      action: 'inspect',
      input: {},
      json: false,
      output: {
        writeStdout: (s: string) => {
          stdout += s;
        },
        writeStderr: (s: string) => {
          stderr += s;
        },
      },
      setExitCode: () => {
        throw new Error('unexpected-failure');
      },
    };
    await instanceCommand(options);
    assert.ok(stdout.includes(identity.displayName));
    assert.ok(stdout.includes('***' + identity.instanceId.slice(-4)));
    assert.ok(!stdout.includes(identity.instanceId));
    stdout = '';
    await instanceCommand({ ...options, json: true });
    assert.equal(JSON.parse(stdout).instanceId, identity.instanceId);
    assert.equal(stderr, '');
  });

  it('should preserve identity actions, missing recovery and json while wrapping human summaries', async () => {
    const store = new AssignmentClaimStore(join(root, 'instance'));
    async function capture(action: string, input = {}, json = false, columns = 32, color = false) {
      const events: Array<{ stream: string; text: string }> = [];
      let exitCode = 0;
      await instanceCommand({
        store,
        action,
        input,
        json,
        terminalColumns: columns,
        styles: createCliStyles(color ? { FORCE_COLOR: '3' } : { NO_COLOR: '1', FORCE_COLOR: '3' }),
        output: {
          writeStdout: (text) => events.push({ stream: 'stdout', text }),
          writeStderr: (text) => events.push({ stream: 'stderr', text }),
        },
        setExitCode: (code) => {
          exitCode = code;
        },
      });
      return { events, exitCode };
    }
    const missing = await capture('inspect');
    assert.equal(missing.exitCode, 1);
    assert.deepEqual(
      missing.events.map((e) => e.stream),
      ['stdout', 'stderr'],
    );
    assert.match(missing.events[0]!.text, /status\s+missing/u);
    assert.match(missing.events[1]!.text, /run install/u);
    const machineMissing = await capture('inspect', {}, true);
    assert.deepEqual(JSON.parse(machineMissing.events[0]!.text), { status: 'missing' });
    assert.equal(machineMissing.events.length, 1);
    assert.equal(machineMissing.exitCode, 1);
    assert.equal(await store.inspect(), undefined);
    await store.identity();
    const renamed = await capture('rename', { name: 'a-long-readable-installation-name' });
    assert.match(renamed.events[0]!.text, /renamed/u);
    const identity = (await store.inspect())!;
    const wide = await capture('inspect', {}, false, 120);
    for (const columns of [16, 32, 80]) {
      const plain = await capture('inspect', {}, false, columns);
      const colored = await capture('inspect', {}, false, columns, true);
      assert.ok(
        colored.events[0]!.text.includes(createCliStyles({ FORCE_COLOR: '3' }).status('ready')),
      );
      assert.deepEqual(
        colored.events.map((e) => ({ ...e, text: ansis.strip(e.text) })),
        plain.events,
      );
      const text = plain.events[0]!.text;
      assert.ok(text.startsWith('\n') && text.endsWith('\n\n'));
      assert.ok(text.split('\n').every((line) => stringWidth(line) <= columns));
      assert.equal(text.replace(/\s/gu, ''), wide.events[0]!.text.replace(/\s/gu, ''));
      assert.ok(text.replace(/\s/gu, '').includes(identity.displayName));
      assert.ok(!text.includes(identity.instanceId));
    }
    const rotated = await capture('rotate', { expectedInstanceId: identity.instanceId });
    assert.match(rotated.events[0]!.text, /rotated/u);
    const saved = (await store.inspect())!;
    assert.notEqual(saved.instanceId, identity.instanceId);
    assert.equal(saved.displayName, identity.displayName);
    const machine = await capture('inspect', {}, true, 16, true);
    assert.deepEqual(JSON.parse(machine.events[0]!.text), { status: 'ready', ...saved });
    assert.equal(machine.events.length, 1);
    assert.equal(machine.exitCode, 0);
  });
});
