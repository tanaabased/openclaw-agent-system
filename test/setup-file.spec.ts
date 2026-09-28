import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

import discoverManifest from '../manifest/discover.ts';
import { loadDiscoveredManifest } from '../manifest/load.ts';
import AgentManifestService from '../manifest/service.ts';
import { normalizeAgentSetup } from '../manifest/setup-schema.ts';
import setupStepApplies from '../agent/setup-runtime.ts';

describe('manifest/setup-file', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-setup-file-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function manifest(reference = './setup.yaml', preferred = false) {
    const directory = preferred ? join(root, '.agent-system') : root;
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'agent.yaml'),
      `schema-version: 1\nagent:\n  id: test\nsetup:\n  file: ${JSON.stringify(reference)}\n`,
    );
    return directory;
  }

  async function load() {
    return loadDiscoveredManifest(await discoverManifest(root));
  }

  it('should normalize all inline forms from a file without running commands', async () => {
    await manifest();
    for (const source of [
      'echo ready\n',
      'shell: zsh\ncheck: test -f ready\napply: touch ready\n',
      'shell: bash\nsteps:\n  - id: first\n    runtimes: [openclaw]\n    check: [test, -f, ready]\n    apply: [touch, ready]\n  - id: second\n    runtimes: [codex]\n    shell: zsh\n    apply: echo ready\n',
    ]) {
      await writeFile(join(root, 'setup.yaml'), source);
      const result = await load();
      assert.equal(result.status, 'loaded', JSON.stringify(result.diagnostics));
      if (result.status !== 'loaded') continue;
      const expected = normalizeAgentSetup(parse(source));
      assert.equal(expected.status, 'valid');
      if (expected.status !== 'valid') continue;
      assert.deepEqual(result.manifest.setup, expected.setup);
      assert.deepEqual(
        result.manifest.setup?.steps
          .filter((step) => setupStepApplies(step, 'openclaw'))
          .map(({ id }) => id),
        expected.setup.steps
          .filter((step) => setupStepApplies(step, 'openclaw'))
          .map(({ id }) => id),
      );
      assert.deepEqual(
        result.manifest.setup?.steps
          .filter((step) => setupStepApplies(step, 'codex'))
          .map(({ id }) => id),
        expected.setup.steps.filter((step) => setupStepApplies(step, 'codex')).map(({ id }) => id),
      );
    }
  });

  it('should load independent host and agent files while ignoring a legacy fallback', async () => {
    await writeFile(
      join(root, 'agent.yaml'),
      'schema-version: 1\nagent:\n  id: test\nsetup-host:\n  file: ./host.yaml\nsetup-agent:\n  file: ./agent-setup.yaml\nsetup:\n  file: ./missing-legacy.yaml\n',
    );
    await writeFile(join(root, 'host.yaml'), 'check: test -f ready\napply: touch ready\n');
    await writeFile(join(root, 'agent-setup.yaml'), 'apply: echo agent\n');
    const loaded = await load();
    assert.equal(loaded.status, 'loaded', JSON.stringify(loaded.diagnostics));
    if (loaded.status !== 'loaded') return;
    const host = normalizeAgentSetup(parse('check: test -f ready\napply: touch ready\n'));
    const agent = normalizeAgentSetup(parse('apply: echo agent\n'));
    assert.equal(host.status, 'valid');
    assert.equal(agent.status, 'valid');
    if (host.status !== 'valid' || agent.status !== 'valid') return;
    assert.deepEqual(loaded.manifest.setupHost, host.setup);
    assert.deepEqual(loaded.manifest.setup, agent.setup);
    assert.equal(loaded.setupHostFilePath, join(root, 'host.yaml'));
    assert.equal(loaded.setupFilePath, join(root, 'agent-setup.yaml'));
    assert.ok(
      loaded.diagnostics.some(
        ({ code, severity }) => code === 'manifest-setup-deprecated' && severity === 'warning',
      ),
    );
  });

  it('should attribute an invalid host file reference to setup-host', async () => {
    await writeFile(
      join(root, 'agent.yaml'),
      'schema-version: 1\nagent:\n  id: test\nsetup-host:\n  file: ../outside.yaml\n',
    );
    const result = await load();
    assert.equal(result.status, 'invalid');
    assert.ok(
      result.diagnostics.some(
        ({ code, fieldPath }) =>
          code === 'manifest-setup-file-escape' && fieldPath === '/setup-host/file',
      ),
    );
  });

  it('should invalidate the cached manifest when only the host file changes', async () => {
    await writeFile(
      join(root, 'agent.yaml'),
      'schema-version: 1\nagent:\n  id: test\nsetup-host:\n  file: ./host.yaml\n',
    );
    const included = join(root, 'host.yaml');
    await writeFile(included, 'apply: echo first\n');
    const service = new AgentManifestService({
      getConfig: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
      parseSessionAgentId: () => 'test',
      resolveAgentWorkspaceDir: () => root,
    });
    const first = await service.loadForAgentId('test');
    assert.equal(first.status, 'loaded');
    assert.strictEqual(await service.loadForAgentId('test'), first);
    await writeFile(included, 'apply: echo other\n');
    const changed = await service.loadForAgentId('test');
    assert.equal(changed.status, 'loaded');
    if (first.status !== 'loaded' || changed.status !== 'loaded') return;
    assert.notEqual(changed.digest, first.digest);
  });

  it('should resolve relative to the selected manifest and reject escapes through symlinks', async () => {
    await manifest('./setup.yaml', true);
    await writeFile(join(root, 'setup.yaml'), 'apply: wrong\n');
    await writeFile(join(root, '.agent-system', 'setup.yaml'), 'apply: right\n');
    const selected = await load();
    assert.equal(selected.status, 'loaded');
    if (selected.status === 'loaded')
      assert.equal(
        selected.manifest.setup?.steps[0]?.apply.kind === 'shell'
          ? selected.manifest.setup.steps[0].apply.script
          : undefined,
        'right',
      );

    const outside = await mkdtemp(join(tmpdir(), 'agent-system-outside-'));
    try {
      await writeFile(join(outside, 'setup.yaml'), 'apply: forbidden\n');
      await symlink(join(outside, 'setup.yaml'), join(root, '.agent-system', 'linked.yaml'));
      await manifest('./linked.yaml', true);
      const escaped = await load();
      assert.equal(escaped.status, 'invalid');
      assert.ok(
        escaped.diagnostics.some(
          ({ code, fieldPath }) =>
            code === 'manifest-setup-file-escape' && fieldPath === '/setup/file',
        ),
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('should reject invalid references and report the referenced file and field', async () => {
    for (const reference of [
      '/tmp/setup.yaml',
      'https://example.com/setup.yaml',
      '../escape.yaml',
    ]) {
      await manifest(reference);
      const result = await load();
      assert.equal(result.status, 'invalid');
      assert.ok(result.diagnostics.some(({ fieldPath }) => fieldPath === '/setup/file'));
    }
    await manifest('./missing.yaml');
    const missing = await load();
    assert.equal(missing.status, 'invalid');
    assert.ok(
      missing.diagnostics.some(
        ({ code, message }) =>
          code === 'manifest-setup-file-unreadable' && message.includes('./missing.yaml'),
      ),
    );

    await manifest();
    await writeFile(join(root, 'setup.yaml'), 'steps: [\n');
    const malformed = await load();
    assert.equal(malformed.status, 'invalid');
    assert.ok(
      malformed.diagnostics.some(
        ({ code, message }) => code === 'yaml-parse-error' && message.includes('./setup.yaml'),
      ),
    );
    await writeFile(join(root, 'setup.yaml'), 'steps:\n  - id: first\n    check: true\n');
    const invalid = await load();
    assert.equal(invalid.status, 'invalid');
    assert.ok(
      invalid.diagnostics.some(
        ({ fieldPath, message }) =>
          fieldPath === '/setup/steps/0/apply' && message.includes('./setup.yaml'),
      ),
    );
    await writeFile(join(root, 'setup.yaml'), 'file: ./recursive.yaml\n');
    const recursive = await load();
    assert.equal(recursive.status, 'invalid');
    assert.ok(recursive.diagnostics.some(({ fieldPath }) => fieldPath === '/setup/file'));
  });

  it('should reject mixing file with inline fields', async () => {
    await writeFile(
      join(root, 'agent.yaml'),
      'schema-version: 1\nagent:\n  id: test\nsetup:\n  file: ./setup.yaml\n  apply: echo wrong\n',
    );
    const result = await load();
    assert.equal(result.status, 'invalid');
    assert.ok(result.diagnostics.some(({ fieldPath }) => fieldPath === '/setup/apply'));
  });

  it('should invalidate cached and approved state after an include-only edit', async () => {
    await manifest();
    const included = join(root, 'setup.yaml');
    await writeFile(included, 'apply: echo first\n');
    const service = new AgentManifestService({
      getConfig: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
      parseSessionAgentId: () => 'test',
      resolveAgentWorkspaceDir: () => root,
    });
    const first = await service.loadForAgentId('test');
    assert.equal(first.status, 'loaded');
    assert.strictEqual(await service.loadForAgentId('test'), first);
    await writeFile(included, 'apply: echo other\n');
    const changed = await service.loadForAgentId('test');
    assert.equal(changed.status, 'loaded');
    if (first.status !== 'loaded' || changed.status !== 'loaded') return;
    assert.notEqual(changed.digest, first.digest);
    await service.withSnapshot(first, new AbortController().signal, async () => {
      const rejected = await service.loadForAgentId('test');
      assert.equal(rejected.status, 'invalid');
      assert.ok(rejected.diagnostics.some(({ code }) => code === 'manifest-approval-changed'));
    });
  });
});
