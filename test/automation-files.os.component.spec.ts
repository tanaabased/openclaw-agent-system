import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import automationContent from '../manifest/automation-content.ts';
import discoverManifest from '../manifest/discover.ts';
import { loadDiscoveredManifest } from '../manifest/load.ts';
import AgentManifestService from '../manifest/service.ts';

describe('manifest/automation-files', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-automation-'));
    await mkdir(join(root, '.agent-system'));
    await mkdir(join(root, 'prompts'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function manifest(declaration = '{ file: ./jobs.yaml }') {
    await writeFile(
      join(root, '.agent-system/agent.yaml'),
      `schema-version: 1\nagent: {id: test}\nautomations: ${declaration}\n`,
    );
  }
  async function load() {
    return loadDiscoveredManifest(await discoverManifest(root));
  }
  function service() {
    return new AgentManifestService({
      getConfig: () => ({}),
      logger: { info() {}, warn() {}, error() {} },
      parseSessionAgentId: () => 'test',
      resolveAgentWorkspaceDir: () => root,
    });
  }
  async function fixture() {
    await manifest();
    await writeFile(
      join(root, '.agent-system/jobs.yaml'),
      '- id: review\n  schedule: in 1 hour\n  prompt: {file: ../prompts/review.md}\n',
    );
    await writeFile(join(root, 'prompts/review.md'), 'Review the workspace.\n');
  }

  it('should resolve yaml and prompt paths from their containing files without executing content', async () => {
    await fixture();
    const result = await load();
    assert.equal(result.status, 'loaded', JSON.stringify(result.diagnostics));
    if (result.status !== 'loaded') return;
    assert.equal(result.scope.workspaceDir, root);
    assert.deepEqual(result.manifest.automations?.[0]?.payload, {
      kind: 'prompt',
      prompt: 'Review the workspace.\n',
    });
    assert.equal(result.automationFiles?.length, 2);
    await manifest('[{id: review, schedule: in 1 hour, prompt: {file: ../prompts/review.md}}]');
    const inline = await load();
    assert.equal(inline.status, 'loaded');
    if (inline.status === 'loaded')
      assert.deepEqual(inline.manifest.automations, result.manifest.automations);
  });

  it('should reload dependencies while keeping formatting-only yaml edits out of effective drift', async () => {
    await fixture();
    const loader = service();
    const first = await loader.loadForAgentId('test');
    assert.equal(first.status, 'loaded');
    if (first.status !== 'loaded') return;
    assert.strictEqual(await loader.loadForAgentId('test'), first);
    const original = automationContent(first.manifest.automations![0]!, 'openclaw');
    await writeFile(
      join(root, '.agent-system/jobs.yaml'),
      '# same job\n- prompt: { file: ../prompts/review.md }\n  schedule: { in: 60 minutes }\n  enabled: true\n  id: review\n',
    );
    const formatted = await loader.loadForAgentId('test');
    assert.equal(formatted.status, 'loaded');
    if (formatted.status !== 'loaded') return;
    assert.notEqual(formatted.digest, first.digest);
    assert.equal(
      automationContent(formatted.manifest.automations![0]!, 'openclaw').hash,
      original.hash,
    );
    await writeFile(join(root, 'prompts/review.md'), 'Review changed content.\n');
    const changed = await loader.loadForAgentId('test');
    assert.equal(changed.status, 'loaded');
    if (changed.status !== 'loaded') return;
    assert.notEqual(changed.digest, formatted.digest);
    const effective = automationContent(changed.manifest.automations![0]!, 'openclaw');
    assert.notEqual(effective.hash, original.hash);
    assert.equal(effective.triggerHash, original.triggerHash);
    await loader.withSnapshot(formatted, new AbortController().signal, async () => {
      assert.equal((await loader.loadForAgentId('test')).status, 'invalid');
    });
  });

  it('should not recursively hash executable dependencies', async () => {
    await manifest('[{id: script, schedule: every 1 hour, run: [node, ./task.mjs]}]');
    const first = await load();
    assert.equal(first.status, 'loaded');
    await writeFile(join(root, 'task.mjs'), 'process.exit(1);');
    const second = await load();
    assert.equal(second.status, 'loaded');
    if (first.status !== 'loaded' || second.status !== 'loaded') return;
    assert.equal(first.digest, second.digest);
    assert.equal(
      automationContent(first.manifest.automations![0]!, 'openclaw').hash,
      automationContent(second.manifest.automations![0]!, 'openclaw').hash,
    );
  });

  it('should recover missing references and reject deleted or malformed files instead of returning no jobs', async () => {
    await fixture();
    const loader = service();
    assert.equal((await loader.loadForAgentId('test')).status, 'loaded');
    await rm(join(root, 'prompts/review.md'));
    assert.equal((await loader.loadForAgentId('test')).status, 'invalid');
    await writeFile(join(root, 'prompts/review.md'), 'Restored.');
    assert.equal((await loader.loadForAgentId('test')).status, 'loaded');
    await rm(join(root, '.agent-system/jobs.yaml'));
    assert.equal((await loader.loadForAgentId('test')).status, 'invalid');
    await writeFile(join(root, '.agent-system/jobs.yaml'), 'file: ./recursive.yaml');
    assert.equal((await loader.loadForAgentId('test')).status, 'invalid');
    await writeFile(join(root, '.agent-system/jobs.yaml'), '[]');
    const empty = await loader.loadForAgentId('test');
    assert.equal(empty.status, 'loaded');
    if (empty.status === 'loaded') assert.deepEqual(empty.manifest.automations, []);
  });

  it('should reject unsafe paths, invalid encodings, oversized files and nonregular references', async () => {
    await fixture();
    for (const reference of [
      '/tmp/elsewhere',
      'https://example.com/jobs.yaml',
      '../../escape.yaml',
      './directory',
    ]) {
      if (reference === './directory') await mkdir(join(root, '.agent-system/directory'));
      await manifest(`{ file: '${reference}' }`);
      assert.equal((await load()).status, 'invalid', reference);
    }
    await manifest();
    for (const contents of [
      Buffer.from([0xff]),
      Buffer.alloc(1024 * 1024 + 1, 'x'),
      Buffer.from('- id: duplicate\n  id: other\n'),
      Buffer.from('&anchor []'),
    ]) {
      await writeFile(join(root, '.agent-system/jobs.yaml'), contents);
      assert.equal((await load()).status, 'invalid');
    }
    await fixture();
    for (const contents of [
      ' ',
      'bad\0content',
      Buffer.from([0xff]),
      Buffer.alloc(1024 * 1024 + 1, 'x'),
    ]) {
      await writeFile(join(root, 'prompts/review.md'), contents);
      assert.equal((await load()).status, 'invalid');
    }
  });

  it('should reject symlink escapes after cached success and recover repaired links', async () => {
    await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'agent-system-automation-outside-'));
    try {
      await writeFile(join(outside, 'review.md'), 'Review the workspace.\n');
      const loader = service();
      assert.equal((await loader.loadForAgentId('test')).status, 'loaded');
      await rm(join(root, 'prompts/review.md'));
      await symlink(join(outside, 'review.md'), join(root, 'prompts/review.md'));
      const escaped = await loader.loadForAgentId('test');
      assert.equal(escaped.status, 'invalid');
      assert.ok(
        escaped.diagnostics.some((item) => item.code === 'manifest-automation-prompt-file-escape'),
      );
      await rm(join(root, 'prompts/review.md'));
      await writeFile(join(root, 'prompts/review.md'), 'Restored.');
      assert.equal((await loader.loadForAgentId('test')).status, 'loaded');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
