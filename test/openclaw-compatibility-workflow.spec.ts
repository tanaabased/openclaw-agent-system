import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
}

interface CompatibilityWorkflow {
  jobs?: {
    compatibility?: {
      permissions?: Record<string, string>;
      'runs-on'?: string;
      steps?: WorkflowStep[];
      strategy?: {
        'fail-fast'?: boolean;
        matrix?: {
          'openclaw-version'?: string[];
        };
      };
    };
  };
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
}

describe('openclaw compatibility workflow', () => {
  it('should validate the supported openclaw matrix through an installed plugin', async () => {
    const source = await readFile('.github/workflows/pr-openclaw-compatibility-tests.yml', 'utf8');
    const workflow = parse(source) as CompatibilityWorkflow;
    const compatibility = workflow.jobs?.compatibility;
    const steps = compatibility?.steps ?? [];
    const targetInstall = steps.find(
      ({ name }) => name === 'Install OpenClaw compatibility target',
    );
    const packagePreparation = steps.find(({ name }) => name === 'Pack prepared plugin');
    const installedExample = steps.find(
      ({ name }) => name === 'Run installed compatibility example',
    );

    assert.equal(workflow.name, 'OpenClaw compatibility tests');
    assert.equal(Object.hasOwn(workflow.on ?? {}, 'pull_request'), true);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.equal(compatibility?.['runs-on'], 'ubuntu-24.04');
    assert.equal(compatibility?.strategy?.['fail-fast'], false);
    assert.deepEqual(compatibility?.strategy?.matrix?.['openclaw-version'], [
      '2026.9.2',
      '2026.9.3',
    ]);
    assert.match(targetInstall?.run ?? '', /bun add --no-save --ignore-scripts --exact/u);
    assert.equal(
      packagePreparation?.env?.OPENCLAW_COMPATIBILITY_TEST_VERSION,
      '${{ matrix.openclaw-version }}',
    );
    assert.equal(
      installedExample?.run,
      'bun run leia examples/install/README.md --stdin --retry 0',
    );
  });
});
