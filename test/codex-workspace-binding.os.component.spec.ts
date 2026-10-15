import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bindCodexWorkspace,
  codexWorkspaceBindingPath,
  inspectCodexWorkspaceBinding,
  previewCodexWorkspace,
  unbindCodexWorkspace,
} from '../agent/codex-workspace-binding.ts';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-system-codex-binding-')));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

async function validWorkspace(root: string, id: string): Promise<string> {
  const workspace = join(root, id);
  await mkdir(workspace);
  await writeFile(join(workspace, 'agent.yaml'), `schema-version: 1\nagent:\n  id: ${id}\n`);
  return workspace;
}

describe('agent/codex-workspace-binding', () => {
  it('should persist and inspect one canonical workspace pointer', async () => {
    const root = await temporaryRoot();
    const pluginData = join(root, 'plugin-data');
    const workspace = await validWorkspace(root, 'emori');
    const alias = join(root, 'workspace-alias');
    await symlink(workspace, alias);

    const bound = await bindCodexWorkspace(pluginData, alias);

    assert.equal(bound.status, 'bound');
    if (bound.status !== 'bound') return;
    assert.equal(bound.binding.workspaceDir, workspace);
    assert.deepEqual(JSON.parse(await readFile(bound.path, 'utf8')), {
      schemaVersion: 1,
      workspaceDir: workspace,
    });
    const inspected = await inspectCodexWorkspaceBinding(pluginData);
    assert.equal(inspected.status, 'bound');
    if (inspected.status !== 'bound' || inspected.preview.status !== 'ready') return;
    assert.equal(inspected.preview.manifest.status, 'loaded');
  });

  it('should require an explicit override for a workspace without a manifest', async () => {
    const root = await temporaryRoot();
    const pluginData = join(root, 'plugin-data');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);

    const preview = await bindCodexWorkspace(pluginData, workspace);

    assert.equal(preview.status, 'confirmation-required');
    if (preview.status !== 'confirmation-required' || preview.preview.status !== 'ready') return;
    assert.equal(preview.preview.manifest.status, 'unmanaged');
    assert.equal((await inspectCodexWorkspaceBinding(pluginData)).status, 'unbound');

    const bound = await bindCodexWorkspace(pluginData, workspace, { allowInactive: true });
    assert.equal(bound.status, 'bound');
  });

  it('should require an explicit override for a malformed manifest', async () => {
    const root = await temporaryRoot();
    const pluginData = join(root, 'plugin-data');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'agent.yaml'), 'agent: [broken\n');

    const preview = await bindCodexWorkspace(pluginData, workspace);

    assert.equal(preview.status, 'confirmation-required');
    if (preview.status !== 'confirmation-required' || preview.preview.status !== 'ready') return;
    assert.equal(preview.preview.manifest.status, 'invalid');
    const bound = await bindCodexWorkspace(pluginData, workspace, { allowInactive: true });
    assert.equal(bound.status, 'bound');
  });

  it('should reject a missing workspace even when inactive binding is allowed', async () => {
    const root = await temporaryRoot();
    const result = await bindCodexWorkspace(join(root, 'plugin-data'), join(root, 'missing'), {
      allowInactive: true,
    });

    assert.equal(result.status, 'rejected');
    assert.equal(
      result.status === 'rejected' ? result.preview.code : undefined,
      'workspace-missing',
    );
  });

  it('should replace the previous workspace binding', async () => {
    const root = await temporaryRoot();
    const pluginData = join(root, 'plugin-data');
    const first = await validWorkspace(root, 'first');
    const second = await validWorkspace(root, 'second');

    assert.equal((await bindCodexWorkspace(pluginData, first)).status, 'bound');
    assert.equal((await bindCodexWorkspace(pluginData, second)).status, 'bound');

    const inspected = await inspectCodexWorkspaceBinding(pluginData);
    assert.equal(inspected.status, 'bound');
    assert.equal(inspected.status === 'bound' ? inspected.binding.workspaceDir : undefined, second);
  });

  it('should remove only the persisted pointer when unbinding', async () => {
    const root = await temporaryRoot();
    const pluginData = join(root, 'plugin-data');
    const workspace = await validWorkspace(root, 'emori');
    await bindCodexWorkspace(pluginData, workspace);

    await unbindCodexWorkspace(pluginData);

    assert.equal((await inspectCodexWorkspaceBinding(pluginData)).status, 'unbound');
    assert.equal((await previewCodexWorkspace(workspace)).status, 'ready');
  });

  it('should report malformed binding state without following it', async () => {
    const root = await temporaryRoot();
    const pluginData = join(root, 'plugin-data');
    const path = codexWorkspaceBindingPath(pluginData);
    await mkdir(pluginData);
    await writeFile(path, '{"schemaVersion":1,"workspaceDir":"relative"}\n');

    const inspected = await inspectCodexWorkspaceBinding(pluginData);

    assert.deepEqual(inspected, {
      status: 'invalid',
      path,
      code: 'binding-invalid',
      message: 'The Codex workspace binding is malformed.',
    });
  });

  it('should reject a symbolic-link binding file', async () => {
    const root = await temporaryRoot();
    const pluginData = join(root, 'plugin-data');
    const path = codexWorkspaceBindingPath(pluginData);
    const target = join(root, 'outside.json');
    await mkdir(pluginData);
    await writeFile(target, '{"schemaVersion":1,"workspaceDir":"/tmp"}\n');
    await symlink(target, path);

    const inspected = await inspectCodexWorkspaceBinding(pluginData);

    assert.equal(inspected.status, 'invalid');
    assert.equal(
      inspected.status === 'invalid' ? inspected.code : undefined,
      'binding-not-regular-file',
    );
  });
});
