import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadManifestDefinitions } from '../manifest/public.ts';

describe('manifest/public', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'manifest-public-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should discover definitions without runtime readiness or credential resolution', async () => {
    await writeFile(
      join(root, 'agent.yaml'),
      `schema-version: 1
agent: { id: portable, runtime: codex }
debug: true
environment: { dotenv: ./missing.env, required: [UNRESOLVED_SECRET] }
automations:
  - id: review
    schedule: every 1 hour
    prompt: Review.
    runtimes: [openclaw, codex]
`,
    );
    const result = await loadManifestDefinitions({ workspaceDir: root });
    assert.equal(result.status, 'loaded', JSON.stringify(result.diagnostics));
    if (result.status !== 'loaded') return;
    assert.equal(result.manifest.agent.id, 'portable');
    assert.equal(result.manifest.debug, true);
    assert.equal(result.manifest.automations?.[0]?.id, 'review');
    assert.deepEqual(result.manifest.automations?.[0]?.payload, {
      kind: 'prompt',
      prompt: 'Review.',
    });
  });

  it('should load an explicit manifest and resolve references relative to their yaml files', async () => {
    await mkdir(join(root, 'definitions/jobs'), { recursive: true });
    await writeFile(join(root, 'agent.yaml'), 'not: a manifest');
    await writeFile(
      join(root, 'definitions/custom.yaml'),
      'schema-version: 1\nagent: {id: selected}\nautomations: {file: ./jobs/automations.yaml}\n',
    );
    await writeFile(
      join(root, 'definitions/jobs/automations.yaml'),
      '- id: external\n  schedule: in 1 hour\n  prompt: {file: ./review.md}\n',
    );
    await writeFile(join(root, 'definitions/jobs/review.md'), 'External prompt.\n');
    await writeFile(join(root, 'definitions/agent.local.yaml'), 'debug: true\n');
    const result = await loadManifestDefinitions({
      workspaceDir: root,
      manifestPath: 'definitions/custom.yaml',
    });
    assert.equal(result.status, 'loaded', JSON.stringify(result.diagnostics));
    if (result.status !== 'loaded') return;
    assert.equal(result.manifest.agent.id, 'selected');
    assert.equal(result.manifest.debug, true);
    assert.equal(result.overlayPath, join(root, 'definitions/agent.local.yaml'));
    assert.deepEqual(result.manifest.automations?.[0]?.payload, {
      kind: 'prompt',
      prompt: 'External prompt.\n',
    });
    assert.equal(result.automationFiles?.length, 2);
  });

  it('should distinguish an absent workspace manifest from a missing explicitly selected file', async () => {
    assert.equal((await loadManifestDefinitions({ workspaceDir: root })).status, 'unmanaged');
    await writeFile(join(root, 'agent.yaml'), 'schema-version: 1\nagent: {id: fallback}\n');
    const result = await loadManifestDefinitions({
      workspaceDir: root,
      manifestPath: 'missing.yaml',
    });
    assert.equal(result.status, 'invalid');
    assert.ok(result.diagnostics.some(({ severity }) => severity === 'error'));
  });
});
