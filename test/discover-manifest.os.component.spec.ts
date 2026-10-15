import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import discoverManifest, {
  discoverManifestFromDirectory,
  maximumManifestBytes,
} from '../manifest/discover.ts';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-system-discovery-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('manifest/discover', () => {
  it('should report a workspace without a manifest as unmanaged', async () => {
    const result = await discoverManifest(await temporaryRoot());

    assert.equal(result.selected, undefined);
    assert.deepEqual(result.diagnostics, []);
  });

  it('should discover the root shorthand manifest', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'agent.yaml'), 'schema-version: 1\n');

    const result = await discoverManifest(root);

    assert.equal(result.selected?.status, 'readable');
    assert.equal(result.selected?.path, join(root, 'agent.yaml'));
  });

  it('should discover the nearest ancestor manifest from a nested directory', async () => {
    const root = await temporaryRoot();
    const workspace = join(root, 'workspace');
    const nested = join(workspace, 'project', 'packages');
    await mkdir(nested, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent.yaml'), 'schema-version: 1\n'),
      writeFile(join(workspace, 'agent.yaml'), 'schema-version: 1\n'),
    ]);

    const result = await discoverManifestFromDirectory(nested);

    assert.equal(result.workspaceDir, workspace);
    assert.equal(result.selected?.path, join(workspace, 'agent.yaml'));
  });

  it('should discover the parent workspace from inside its managed worktree root', async () => {
    const root = await temporaryRoot();
    const workspace = join(root, 'workspace');
    const manifestDirectory = join(workspace, '.agent-system');
    const nested = join(manifestDirectory, 'worktrees', 'repo', 'task');
    await mkdir(nested, { recursive: true });
    await writeFile(join(manifestDirectory, 'agent.yaml'), 'schema-version: 1\n');

    const result = await discoverManifestFromDirectory(nested);

    assert.equal(result.workspaceDir, workspace);
    assert.equal(result.selected?.path, join(manifestDirectory, 'agent.yaml'));
  });

  it('should stop at an invalid nearest ancestor manifest', async () => {
    const root = await temporaryRoot();
    const workspace = join(root, 'workspace');
    const nested = join(workspace, 'project', 'packages');
    await mkdir(nested, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'agent.yaml'), 'schema-version: 1\n'),
      mkdir(join(workspace, 'agent.yaml')),
    ]);

    const result = await discoverManifestFromDirectory(nested);

    assert.equal(result.workspaceDir, workspace);
    assert.equal(result.selected?.status, 'invalid');
    assert.equal(result.selected?.path, join(workspace, 'agent.yaml'));
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['manifest-not-regular-file'],
    );
  });

  it('should prefer .agent-system/agent.yaml and warn about the ignored shorthand', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, '.agent-system'));
    await Promise.all([
      writeFile(join(root, '.agent-system', 'agent.yaml'), 'schema-version: 1\n'),
      writeFile(join(root, 'agent.yaml'), 'schema-version: 1\n'),
    ]);

    const result = await discoverManifest(root);

    assert.equal(result.selected?.path, join(root, '.agent-system', 'agent.yaml'));
    assert.equal(result.ignoredPath, join(root, 'agent.yaml'));
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['manifest-shadowed'],
    );
  });

  it('should reject an invalid preferred manifest instead of using the shorthand', async () => {
    const root = await temporaryRoot();
    const preferredDirectory = join(root, '.agent-system');
    const preferredPath = join(preferredDirectory, 'agent.yaml');
    await mkdir(preferredDirectory);
    await Promise.all([
      writeFile(join(root, 'target.yaml'), 'schema-version: 1\n'),
      writeFile(join(root, 'agent.yaml'), 'schema-version: 1\n'),
    ]);
    await symlink(join(root, 'target.yaml'), preferredPath);

    const result = await discoverManifest(root);

    assert.equal(result.selected?.status, 'invalid');
    assert.equal(result.selected?.path, preferredPath);
    assert.equal(result.ignoredPath, join(root, 'agent.yaml'));
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['manifest-shadowed', 'manifest-not-regular-file'],
    );
  });

  it('should reject a manifest symlink', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'target.yaml'), 'schema-version: 1\n');
    await symlink(join(root, 'target.yaml'), join(root, 'agent.yaml'));

    const result = await discoverManifest(root);

    assert.equal(result.selected?.status, 'invalid');
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['manifest-not-regular-file'],
    );
  });

  it('should reject a symlinked .agent-system directory', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'target');
    await mkdir(target);
    await writeFile(join(target, 'agent.yaml'), 'schema-version: 1\n');
    await symlink(target, join(root, '.agent-system'));

    const result = await discoverManifest(root);

    assert.equal(result.selected?.status, 'invalid');
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['manifest-directory-not-real'],
    );
  });

  it('should reject a manifest over the size limit', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'agent.yaml'), Buffer.alloc(maximumManifestBytes + 1));

    const result = await discoverManifest(root);

    assert.equal(result.selected?.status, 'invalid');
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['manifest-too-large'],
    );
  });
});
