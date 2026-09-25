import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { CodexSetupError, inspectCodexSetup, installCodexSetup } from '../agent/codex-setup.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';

describe('agent/codex-setup', () => {
  let root: string;
  let pluginData: string;
  let workspace: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-codex-setup-'));
    pluginData = join(root, 'plugin-data');
    workspace = join(root, 'workspace');
    await mkdir(workspace);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  async function manifest(contents: string): Promise<void> {
    await writeFile(
      join(workspace, 'agent.yaml'),
      `schema-version: 1\nagent:\n  id: emori\n${contents}`,
    );
    await bindCodexWorkspace(pluginData, workspace);
  }

  const dependencies = {
    baseEnvironment: { HOME: '/tmp', PATH: '/bin:/usr/bin' },
  };

  it('should inspect and install only setup steps applicable to codex', async () => {
    await manifest(`setup:
  steps:
    - id: shared
      check: test -f .shared-ready
      apply: touch .shared-ready
    - id: codex-only
      runtimes: [codex]
      apply: touch .codex-applied
    - id: openclaw-only
      runtimes: [openclaw]
      check: touch .openclaw-checked
      apply: touch .openclaw-applied
`);

    const inspected = await inspectCodexSetup(pluginData, undefined, dependencies);
    assert.deepEqual(
      inspected.findings.map(({ code, status, stepId }) => ({ code, status, stepId })),
      [
        { code: 'setup-drift', status: 'drift', stepId: 'shared' },
        { code: 'setup-manual', status: 'manual', stepId: 'codex-only' },
        { code: 'setup-not-applicable', status: 'skipped', stepId: 'openclaw-only' },
      ],
    );

    const installed = await installCodexSetup(pluginData, undefined, dependencies);
    assert.deepEqual(
      installed.outcomes.map(({ code, status, stepId }) => ({ code, status, stepId })),
      [
        { code: 'setup-applied', status: 'updated', stepId: 'shared' },
        { code: 'setup-applied', status: 'updated', stepId: 'codex-only' },
        { code: 'setup-not-applicable', status: 'skipped', stepId: 'openclaw-only' },
      ],
    );
    await Promise.all([
      access(join(workspace, '.shared-ready')),
      access(join(workspace, '.codex-applied')),
    ]);
    await assert.rejects(access(join(workspace, '.openclaw-checked')));
    await assert.rejects(access(join(workspace, '.openclaw-applied')));

    const repeated = await installCodexSetup(pluginData, undefined, dependencies);
    assert.equal(repeated.outcomes[0]?.code, 'setup-unchanged');
    assert.equal(repeated.outcomes[1]?.code, 'setup-applied');
  });

  it('should report secret-safe doctor findings without applying setup', async () => {
    await manifest(`setup:
  steps:
    - id: healthy
      check: |
        printf 'private healthy output\\n'
        exit 0
      apply: touch .healthy-applied
    - id: drift
      check: |
        printf 'private drift output\\n'
        exit 1
      apply: touch .drift-applied
    - id: blocked
      check: |
        printf 'private blocked output\\n' >&2
        exit 2
      apply: touch .blocked-applied
    - id: skipped
      runtimes: [openclaw]
      check: touch .skipped-checked
      apply: touch .skipped-applied
`);

    const inspected = await inspectCodexSetup(pluginData, undefined, dependencies);

    assert.deepEqual(
      inspected.findings.map(({ code, status, stepId }) => ({ code, status, stepId })),
      [
        { code: 'setup-healthy', status: 'healthy', stepId: 'healthy' },
        { code: 'setup-drift', status: 'drift', stepId: 'drift' },
        { code: 'setup-blocked', status: 'blocked', stepId: 'blocked' },
        { code: 'setup-not-applicable', status: 'skipped', stepId: 'skipped' },
      ],
    );
    assert.doesNotMatch(JSON.stringify(inspected), /private (?:healthy|drift|blocked) output/u);
    await Promise.all(
      [
        '.healthy-applied',
        '.drift-applied',
        '.blocked-applied',
        '.skipped-checked',
        '.skipped-applied',
      ].map((path) => assert.rejects(access(join(workspace, path)))),
    );
  });

  it('should wire runner debug diagnostics to the standalone adapter stderr boundary', async () => {
    await manifest(`setup:
  check: 'true'
  apply: 'true'
`);
    const diagnostics: string[] = [];

    const inspected = await inspectCodexSetup(pluginData, undefined, {
      baseEnvironment: { ...dependencies.baseEnvironment, RUNNER_DEBUG: '1' },
      writeDebug: (value) => diagnostics.push(value),
      runCommandWithTimeout: async (_argv, options) => {
        assert.equal(options.env.RUNNER_DEBUG, '1');
        return {
          code: 0,
          killed: false,
          signal: null,
          stdout: 'debug: private stdout\n',
          stderr: 'error: private stderr\ndebug: visible setup diagnostic\n',
          termination: 'exit',
        };
      },
    });

    assert.equal(inspected.findings[0]?.code, 'setup-healthy');
    assert.deepEqual(diagnostics, ['debug: visible setup diagnostic\n']);
  });

  it('should stop on the first failure while preserving earlier effects', async () => {
    await manifest(`setup:
  steps:
    - id: first
      apply: touch .first
    - id: failure
      apply: exit 2
    - id: never
      apply: touch .never
`);

    await assert.rejects(
      installCodexSetup(pluginData, undefined, dependencies),
      (error: unknown) => {
        assert.ok(error instanceof AgentSystemLifecycleError);
        assert.equal(error.code, 'setup-apply-failed');
        assert.equal(error.stepId, 'failure');
        return true;
      },
    );
    await access(join(workspace, '.first'));
    await assert.rejects(access(join(workspace, '.never')));
  });

  it('should reject missing bindings and stale manifests', async () => {
    await assert.rejects(inspectCodexSetup(pluginData), (error: unknown) => {
      assert.ok(error instanceof CodexSetupError);
      assert.equal(error.code, 'codex-workspace-unbound');
      return true;
    });

    await manifest(`setup:
  steps:
    - id: mutate
      check: exit 1
      apply: printf '\\n' >> agent.yaml
`);
    await assert.rejects(
      installCodexSetup(pluginData, undefined, dependencies),
      (error: unknown) => {
        assert.ok(error instanceof CodexSetupError);
        assert.equal(error.code, 'codex-setup-stale');
        return true;
      },
    );
    assert.match(await readFile(join(workspace, 'agent.yaml'), 'utf8'), /\n\n$/u);
  });
});
