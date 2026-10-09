import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import loadBoundToolManifest from '../api/manifest-binding.ts';
import { previewCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { projectCodexManifest } from '../agent/codex-context.ts';
import discoverManifest, { maximumManifestBytes } from '../manifest/discover.ts';
import { loadDiscoveredManifest } from '../manifest/load.ts';
import mergeManifestDocuments from '../manifest/merge-documents.ts';
import AgentManifestService from '../manifest/service.ts';

const roots: string[] = [];
const baseSource = `schema-version: 1
agent:
  id: data
  name: Shared
models:
  default: { model: openai/gpt-6-astra, effort: high }
environment:
  dotenv: [base.env, shared.env]
  required: [SHARED]
  set: { SHARED: inherited, LOCAL: base }
git:
  worktrees:
    repositories:
      local: { shared: /repos/shared }
`;

async function fixture(preferred = false, source = baseSource) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-system-overlay-')));
  roots.push(root);
  const path = join(root, ...(preferred ? ['.agent-system'] : []), 'agent.yaml');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  const overlayPath = join(dirname(path), 'agent.local.yaml');
  const logs: string[] = [];
  const service = new AgentManifestService({
    getConfig: () => ({}),
    logger: {
      error: (line) => logs.push(line),
      info: (line) => logs.push(line),
      warn: (line) => logs.push(line),
    },
    parseSessionAgentId: () => 'data',
    resolveAgentWorkspaceDir: () => root,
  });
  return { root, path, overlayPath, logs, service, load: () => service.loadForAgentId('data') };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('manifest/overlays', () => {
  it('should merge mappings without mutation or prototype assignment and replace arrays wholesale', () => {
    const base = {
      path: 'agent.yaml',
      value: { nested: { a: 1, b: 2 }, list: [1, 2], scalar: 'old' },
    };
    const overlay = {
      path: 'agent.local.yaml',
      value: JSON.parse('{"nested":{},"list":[3],"scalar":null,"__proto__":{"polluted":true}}'),
    };
    const before = structuredClone(base);
    const merged = mergeManifestDocuments(base, overlay);
    assert.deepEqual(
      merged.value,
      JSON.parse('{"nested":{"a":1,"b":2},"list":[3],"scalar":null,"__proto__":{"polluted":true}}'),
    );
    assert.deepEqual(base, before);
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
    assert.deepEqual(merged.sources['/nested/a'], { path: base.path, fieldPath: '/nested/a' });
    assert.equal(merged.sources['/list/1'], undefined);
    assert.equal(merged.sources['/list/0']?.path, overlay.path);
  });

  for (const preferred of [false, true]) {
    it(`should select only the sibling overlay for the ${preferred ? 'preferred' : 'root'} base`, async () => {
      const f = await fixture(preferred);
      const other = preferred ? f.root : join(f.root, '.agent-system');
      await mkdir(other, { recursive: true });
      await writeFile(join(other, 'agent.local.yaml'), 'agent: { id: ignored }');
      if (preferred) await writeFile(join(f.root, 'agent.yaml'), 'invalid base');
      await writeFile(f.overlayPath, 'agent: { name: Local }\nenvironment: { set: {} }');
      const result = await f.load();
      assert.equal(result.status, 'loaded');
      if (result.status !== 'loaded') return;
      assert.equal(result.path, f.path);
      assert.equal(result.overlayPath, f.overlayPath);
      assert.equal(result.manifest.agent.name, 'Local');
      assert.equal(result.manifest.environment?.set?.SHARED, 'inherited');
      assert.equal(result.sources?.['/agent/name']?.path, f.overlayPath);
      assert.equal(result.sources?.['/environment/set/SHARED']?.path, f.path);
    });
  }

  it('should not establish a workspace from an overlay alone', async () => {
    const f = await fixture();
    await rm(f.path);
    await writeFile(f.overlayPath, baseSource);
    assert.equal((await f.load()).status, 'unmanaged');
    assert.equal((await discoverManifest(f.root)).overlay, undefined);
  });

  it('should invalidate cache and approval digests when overlays are added, changed, invalidated, repaired, or removed', async () => {
    const f = await fixture();
    const absent = await f.load();
    assert.equal(absent.status, 'loaded');
    if (absent.status !== 'loaded') return;
    assert.strictEqual(await f.load(), absent);
    await writeFile(f.overlayPath, '{}\n');
    const empty = await f.load();
    assert.equal(empty.status, 'loaded');
    if (empty.status !== 'loaded') return;
    assert.deepEqual(empty.manifest, absent.manifest);
    assert.notEqual(empty.digest, absent.digest);
    await writeFile(f.overlayPath, 'agent: { name: Local }\n');
    const changed = await f.load();
    assert.equal(changed.status, 'loaded');
    if (changed.status !== 'loaded') return;
    assert.notEqual(changed.digest, empty.digest);
    assert.strictEqual(await f.load(), changed);
    await writeFile(f.overlayPath, 'agent: { name: Local }\n# changed bytes\n');
    const commented = await f.load();
    assert.equal(commented.status, 'loaded');
    if (commented.status !== 'loaded') return;
    assert.notEqual(commented.digest, changed.digest);
    await writeFile(f.overlayPath, 'agent: { unsupported: sensitive-value }');
    assert.equal((await f.load()).status, 'invalid');
    await writeFile(f.overlayPath, 'agent: { name: Repaired }');
    assert.equal((await f.load()).status, 'loaded');
    await rm(f.overlayPath);
    const removed = await f.load();
    assert.equal(removed.status, 'loaded');
    if (removed.status !== 'loaded') return;
    assert.equal(removed.digest, absent.digest);
    assert.deepEqual(removed.manifest, absent.manifest);
    assert.equal(f.logs.join('\n').includes('sensitive-value'), false);
  });

  it('should reject any overlay transition inside an approved snapshot', async () => {
    const f = await fixture();
    for (const initial of [undefined, '{}\n']) {
      if (initial === undefined) await rm(f.overlayPath, { force: true });
      else await writeFile(f.overlayPath, initial);
      const approved = await f.load();
      assert.equal(approved.status, 'loaded');
      if (approved.status !== 'loaded') return;
      await f.service.withSnapshot(approved, new AbortController().signal, async () => {
        if (initial === undefined) await writeFile(f.overlayPath, '{}\n');
        else await rm(f.overlayPath);
        const result = await f.load();
        assert.equal(result.status, 'invalid');
        assert.equal(result.diagnostics[0]?.code, 'manifest-approval-changed');
      });
    }
  });

  it('should clear configurable arrays and retain command and runtime boundaries', async () => {
    const f = await fixture();
    await writeFile(
      f.overlayPath,
      `
environment: { dotenv: [], required: [], op: [], path-prepend: [] }
git: { ssh: { private-keys: [] } }
github:
  ssh-keys: []
  ssh-signing-keys: []
  notifications:
    assignment-types: []
    approved-actors: []
    allowed-repository-owners: []
setup-host: { steps: [] }
setup-agent: { apply: [echo, safe], runtimes: [] }
automations:
  - { id: disabled-here, runtimes: [], schedule: 'every 1 hour', prompt: hello, thread: null }
backup: { include: [], exclude: [] }
`,
    );
    const result = await f.load();
    assert.equal(result.status, 'loaded', JSON.stringify(result.diagnostics));
    if (result.status !== 'loaded') return;
    assert.deepEqual(result.manifest.environment?.dotenv, []);
    assert.deepEqual(result.manifest.environment?.required, []);
    assert.deepEqual(result.manifest.github?.notifications?.assignmentTypes, []);
    assert.deepEqual(result.manifest.github?.notifications?.approvedActors, []);
    assert.deepEqual(result.manifest.setupHost?.steps, []);
    assert.deepEqual(result.manifest.setup?.steps[0]?.runtimes, []);
    assert.deepEqual(result.manifest.automations?.[0]?.runtimes, []);
    assert.equal(result.manifest.automations?.[0]?.thread, undefined);
    await writeFile(f.overlayPath, 'setup-agent: { apply: [] }');
    assert.equal((await f.load()).status, 'invalid');
    await writeFile(f.overlayPath, 'automations: []');
    const cleared = await f.load();
    assert.equal(cleared.status, 'loaded');
    if (cleared.status === 'loaded') assert.deepEqual(cleared.manifest.automations, []);
  });

  it('should keep relative file references anchored to the selected manifest directory', async () => {
    const f = await fixture(true);
    await writeFile(join(dirname(f.path), 'local-setup.yaml'), 'apply: [echo, local]');
    await writeFile(join(f.root, 'local-setup.yaml'), 'invalid');
    await writeFile(f.overlayPath, 'setup-agent: { file: local-setup.yaml }');
    const result = await f.load();
    assert.equal(result.status, 'loaded');
    if (result.status !== 'loaded') return;
    assert.equal(result.setupFilePath, join(dirname(f.path), 'local-setup.yaml'));
    assert.equal(result.sources?.['/setup-agent/file']?.path, f.overlayPath);
    await writeFile(f.overlayPath, 'setup-agent: { file: ../../escape.yaml }');
    assert.equal(
      (await f.load()).diagnostics.some(({ code }) => code === 'manifest-setup-file-escape'),
      true,
    );
  });

  const invalidOverlays = [
    ['unknown: sensitive-value', 'manifest-unknown-key'],
    ['"": sensitive-value', 'manifest-unknown-key'],
    ['__proto__: { polluted: true }', 'manifest-unknown-key'],
    ['agent: { typo: sensitive-value }', 'manifest-unknown-key'],
    ['agent: { id: other }', 'agent-id-mismatch'],
    ['agent: null', 'manifest-schema'],
    ['environment: { required: null }', 'manifest-schema'],
    ['[]', 'manifest-schema'],
    ['', 'manifest-schema'],
    ['agent: [', 'yaml-parse-error'],
    ['agent: { name: one, name: two }', 'yaml-duplicate-key'],
    ['agent: &local { name: private }', 'yaml-anchor'],
    ['agent: *local', 'yaml-alias'],
    ['agent: !!map { name: private }', 'yaml-tag'],
  ];
  for (const [overlay, code] of invalidOverlays) {
    it(`should reject and attribute ${code} from ${JSON.stringify(overlay)}`, async () => {
      const f = await fixture();
      await writeFile(f.overlayPath, overlay!);
      const result = await f.load();
      assert.equal(result.status, 'invalid');
      assert.equal(
        result.diagnostics.some(
          (diagnostic) => diagnostic.code === code && diagnostic.sourcePath === f.overlayPath,
        ),
        true,
        JSON.stringify(result.diagnostics),
      );
      assert.equal(f.logs.join('\n').includes('sensitive-value'), false);
    });
  }

  it('should reject oversized, nonregular, and invalid utf-8 overlays without falling back', async () => {
    const f = await fixture();
    for (const content of [Buffer.alloc(maximumManifestBytes + 1), Buffer.from([0xff])]) {
      await writeFile(f.overlayPath, content);
      assert.equal((await f.load()).status, 'invalid');
    }
    await rm(f.overlayPath);
    await symlink(f.path, f.overlayPath);
    assert.equal((await f.load()).status, 'invalid');
    await rm(f.overlayPath);
    await mkdir(f.overlayPath);
    assert.equal((await f.load()).status, 'invalid');
  });

  it('should expose the same effective configuration to both runtimes on independent machines without side effects', async () => {
    const machines = await Promise.all([fixture(true), fixture(true)]);
    const effective = [];
    for (const [index, f] of machines.entries()) {
      await writeFile(
        f.overlayPath,
        `
models: { default: { effort: ${index === 0 ? 'medium' : 'high'} } }
git: { worktrees: { root: /machine-${index}/worktrees, repositories: { local: {} } } }
environment:
  dotenv: [missing-local.env]
  set: { LOCAL: machine-${index}, SECRET: { from-op: 'op://vault/item/password' } }
github: { notifications: { assignment-types: ${index === 0 ? '[]' : '[issue]'} } }
setup-agent: { apply: 'touch must-not-run' }
`,
      );
      const before = await readdir(f.root, { recursive: true });
      const openclaw = await f.service.loadForRuntimeContext(
        { agentId: 'data' },
        'before_prompt_build',
      );
      const codex = await previewCodexWorkspace(f.root);
      assert.equal(openclaw.status, 'loaded', JSON.stringify(openclaw.diagnostics));
      assert.equal(codex.status, 'ready');
      if (openclaw.status !== 'loaded' || codex.status !== 'ready') return;
      assert.equal(codex.manifest.status, 'loaded');
      if (codex.manifest.status !== 'loaded') return;
      assert.deepEqual(codex.manifest.manifest, openclaw.manifest);
      assert.equal(codex.manifest.digest, openclaw.digest);
      assert.equal(openclaw.manifest.models?.default.effort, index === 0 ? 'medium' : 'high');
      assert.deepEqual(openclaw.manifest.environment?.dotenv, ['missing-local.env']);
      assert.equal(openclaw.manifest.environment?.set?.SHARED, 'inherited');
      assert.deepEqual(openclaw.manifest.git?.worktrees?.repositories?.local, {
        shared: '/repos/shared',
      });
      assert.equal(
        JSON.stringify(projectCodexManifest(codex.manifest.manifest)).includes('op://'),
        false,
      );
      assert.deepEqual(await readdir(f.root, { recursive: true }), before);
      assert.equal(await readFile(f.path, 'utf8'), baseSource);
      effective.push(openclaw.manifest);
    }
    assert.notDeepEqual(effective[0], effective[1]);
  });

  it('should preserve authoritative workspace binding even when another workspace claims the same agent', async () => {
    const owned = await fixture();
    const foreign = await fixture();
    await writeFile(owned.overlayPath, 'agent: { name: Local }');
    await writeFile(foreign.overlayPath, 'agent: { id: data }');
    const scope = {
      source: 'tool' as const,
      toolContext: { agentId: 'data', workspaceDir: foreign.root },
    };
    await assert.rejects(loadBoundToolManifest(owned.service, scope), {
      code: 'agent_not_resolved',
    });
    const loaded = await loadBoundToolManifest(owned.service, {
      source: 'tool',
      toolContext: { agentId: 'data', workspaceDir: owned.root },
    });
    assert.equal(loaded.manifest.agent.name, 'Local');
  });

  it('should reject an overlay that becomes a symlink after discovery', async () => {
    const f = await fixture();
    await writeFile(f.overlayPath, '{}');
    const discovery = await discoverManifest(f.root);
    await rm(f.overlayPath);
    await symlink(f.path, f.overlayPath);
    assert.equal((await loadDiscoveredManifest(discovery)).status, 'invalid');
  });
});
