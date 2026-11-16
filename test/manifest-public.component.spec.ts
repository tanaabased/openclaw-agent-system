import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadManifest } from '../manifest/public.ts';

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
    overrides:
      codex: {environment: {type: cloud, name: team}}
`,
    );
    const result = await loadManifest({ workspaceDir: root });
    assert.equal(result.status, 'loaded', JSON.stringify(result.diagnostics));
    if (result.status !== 'loaded') return;
    assert.equal(result.manifest.agent.id, 'portable');
    assert.equal(result.manifest.debug, true);
    assert.equal(result.manifest.automations?.[0]?.id, 'review');
    assert.deepEqual(result.manifest.automations?.[0]?.payload, {
      kind: 'prompt',
      prompt: 'Review.',
    });
    assert.deepEqual(result.manifest.automations?.[0]?.overrides.codex?.environment, {
      type: 'cloud',
      name: 'team',
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
      '- id: external\n  schedule: in 1 hour\n  prompt: {file: ./review.md}\n  overrides:\n    codex: {environment: {type: computer, name: workstation}}\n',
    );
    await writeFile(join(root, 'definitions/jobs/review.md'), 'External prompt.\n');
    await writeFile(join(root, 'definitions/agent.local.yaml'), 'debug: true\n');
    const result = await loadManifest({
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
    assert.deepEqual(result.manifest.automations?.[0]?.overrides.codex?.environment, {
      type: 'computer',
      name: 'workstation',
    });
    assert.equal(result.automationFiles?.length, 2);
  });

  it('should load equivalent bare, wrapped and merged includes with document-local overlays', async () => {
    await mkdir(join(root, 'jobs'));
    await writeFile(join(root, 'jobs/prompt.md'), '!!str plain text, not YAML\n');
    await writeFile(
      join(root, 'agent.yaml'),
      `schema-version: 1
agent: {id: test}
definitions: {common: &common {shell: bash}}
setup-agent: {file: setup.yaml}
setup-host: {<<: *common, apply: echo host}
automations: {file: jobs/jobs.yaml}
`,
    );
    const step = '- id: reports\n  apply: echo reports\n';
    const job = '- id: review\n  schedule: every 1 hour\n  prompt: {file: prompt.md}\n';
    await writeFile(join(root, 'setup.yaml'), step);
    await writeFile(join(root, 'jobs/jobs.yaml'), job);
    const bare = await loadManifest({ workspaceDir: root });
    assert.equal(bare.status, 'loaded', JSON.stringify(bare.diagnostics));
    if (bare.status !== 'loaded') return;
    await writeFile(
      join(root, 'setup.yaml'),
      `file: missing.yaml
arbitrary: [true, null, {file: missing.yaml}]
common: &common {apply: echo reports}
steps: [{id: reports, <<: *common}]
`,
    );
    await writeFile(
      join(root, 'jobs/jobs.yaml'),
      `anything: {file: missing.yaml}
common: &common {schedule: every 1 hour, prompt: {file: prompt.md}}
automations: [{id: review, <<: *common}]
`,
    );
    await writeFile(
      join(root, 'agent.local.yaml'),
      'definitions: {common: {shell: zsh}, extra: [true]}',
    );
    const wrapped = await loadManifest({ workspaceDir: root });
    assert.equal(wrapped.status, 'loaded', JSON.stringify(wrapped.diagnostics));
    if (wrapped.status !== 'loaded') return;
    assert.deepEqual(wrapped.manifest, bare.manifest);
    assert.notEqual(wrapped.digest, bare.digest);
    assert.notEqual(wrapped.setupFileFingerprint, bare.setupFileFingerprint);
    assert.notEqual(
      wrapped.automationFiles?.[0]?.fingerprint,
      bare.automationFiles?.[0]?.fingerprint,
    );
    assert.equal('definitions' in wrapped.manifest, false);
    await writeFile(
      join(root, 'setup.yaml'),
      'common: &common {apply: echo changed}\nsteps: [{id: reports, <<: *common}]',
    );
    const changed = await loadManifest({ workspaceDir: root });
    assert.equal(changed.status, 'loaded');
    if (changed.status === 'loaded') {
      assert.notDeepEqual(changed.manifest.setup, wrapped.manifest.setup);
      assert.notEqual(changed.setupFileFingerprint, wrapped.setupFileFingerprint);
    }
    await writeFile(
      join(root, 'agent.local.yaml'),
      'setup-agent: {<<: *common, apply: echo invalid}',
    );
    const crossDocument = await loadManifest({ workspaceDir: root });
    assert.equal(crossDocument.status, 'invalid');
    assert.ok(crossDocument.diagnostics.some(({ code }) => code === 'yaml-alias-unresolved'));
  });

  for (const key of ['setup-host', 'setup-agent', 'setup']) {
    it(`should retain setup shorthand and select only external steps for ${key}`, async () => {
      await writeFile(
        join(root, 'agent.yaml'),
        `schema-version: 1\nagent: {id: test}\n${key}: {file: setup.yaml}`,
      );
      for (const source of [
        'echo ok',
        'apply: echo ok',
        'steps: [{id: default, apply: echo ok}]',
        '- {id: default, apply: echo ok}',
        'unrelated: null\nsteps: [{id: default, apply: echo ok}]',
      ]) {
        await writeFile(join(root, 'setup.yaml'), source);
        const result = await loadManifest({ workspaceDir: root });
        assert.equal(result.status, 'loaded', JSON.stringify(result.diagnostics));
        if (result.status !== 'loaded') continue;
        const setup = key === 'setup-host' ? result.manifest.setupHost : result.manifest.setup;
        assert.deepEqual(setup?.steps[0]?.apply, {
          kind: 'shell',
          script: 'echo ok',
          shell: 'sh',
          timeoutSeconds: 600,
        });
      }
      await writeFile(
        join(root, 'setup.yaml'),
        'shell: bash\nhelper: false\nsteps: [{id: default, apply: echo ok}]',
      );
      const shell = await loadManifest({ workspaceDir: root });
      assert.equal(shell.status, 'loaded');
      if (shell.status === 'loaded') {
        const setup = key === 'setup-host' ? shell.manifest.setupHost : shell.manifest.setup;
        assert.equal(setup?.steps[0]?.apply.kind === 'shell' && setup.steps[0].apply.shell, 'bash');
      }
      for (const source of [
        'helper: true',
        'steps: null',
        'steps: [{id: test, aply: echo wrong}]',
        'steps: []\napply: echo wrong',

        'shell: unknown\nsteps: []',
        'steps: &cycle [*cycle]',
      ]) {
        await writeFile(join(root, 'setup.yaml'), source);
        const result = await loadManifest({ workspaceDir: root });
        assert.equal(result.status, 'invalid', source);
        assert.ok(
          result.diagnostics.some(({ sourcePath }) => sourcePath === join(root, 'setup.yaml')),
        );
      }
    });
  }

  it('should reject missing or malformed automation payloads rather than declaring no jobs', async () => {
    await writeFile(
      join(root, 'agent.yaml'),
      'schema-version: 1\nagent: {id: test}\nautomations: {file: jobs.yaml}',
    );
    for (const source of [
      'helper: true',
      'automations: null',
      'automations: {file: other.yaml}',
      'automations: [{id: test, schedule: every 1 hour, promt: wrong}]',
      'x: &x [*x]\nautomations: []',
    ]) {
      await writeFile(join(root, 'jobs.yaml'), source);
      const result = await loadManifest({ workspaceDir: root });
      assert.equal(result.status, 'invalid', source);
      assert.ok(
        result.diagnostics.some(({ sourcePath }) => sourcePath === join(root, 'jobs.yaml')),
      );
    }
  });

  it('should distinguish an absent workspace manifest from a missing explicitly selected file', async () => {
    assert.equal((await loadManifest({ workspaceDir: root })).status, 'unmanaged');
    await writeFile(join(root, 'agent.yaml'), 'schema-version: 1\nagent: {id: fallback}\n');
    const result = await loadManifest({
      workspaceDir: root,
      manifestPath: 'missing.yaml',
    });
    assert.equal(result.status, 'invalid');
    assert.ok(result.diagnostics.some(({ severity }) => severity === 'error'));
  });
});
