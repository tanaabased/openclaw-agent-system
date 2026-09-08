import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

interface WorkflowStep {
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
}

interface PackageSmokeWorkflow {
  env?: Record<string, string>;
  jobs?: {
    'package-smoke'?: {
      name?: string;
      'runs-on'?: string;
      steps?: WorkflowStep[];
    };
  };
  name?: string;
  on?: {
    pull_request?: unknown;
    push?: { branches?: string[] };
    workflow_dispatch?: unknown;
  };
}

describe('openclaw package smoke workflow', () => {
  it('should install and exercise the packed candidate on the supported core', async () => {
    const source = await readFile('.github/workflows/pr-openclaw-package-smoke.yml', 'utf8');
    const workflow = parse(source) as PackageSmokeWorkflow;
    const job = workflow.jobs?.['package-smoke'];
    const steps = job?.steps ?? [];
    const pathUpdates = steps.find((step) => step.name === 'PATH updates');
    const install = steps.find((step) => step.name === 'Install OpenClaw 2026.9.3');
    const candidate = steps.find((step) => step.name === 'Verify packed plugin and Gateway');

    assert.equal(workflow.name, 'OpenClaw package smoke test');
    assert.ok(workflow.on && Object.hasOwn(workflow.on, 'pull_request'));
    assert.ok(workflow.on && Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.deepEqual(workflow.on?.push?.branches, ['main']);
    assert.equal(workflow.env?.OPENCLAW_STATE_DIR, undefined);
    assert.match(
      pathUpdates?.run ?? '',
      /OPENCLAW_STATE_DIR=\$RUNNER_TEMP\/openclaw-state.*\$GITHUB_ENV/u,
    );
    assert.equal(job?.name, 'Packed plugin / OpenClaw 2026.9.3');
    assert.equal(job?.['runs-on'], 'ubuntu-24.04');
    assert.match(install?.run ?? '', /openclaw@2026\.9\.3/u);
    assert.doesNotMatch(source, /2026\.7\.1-2|openclaw-agent-system@0\.5\.3/u);
    assert.match(candidate?.run ?? '', /openclaw-setup/u);
    assert.match(candidate?.run ?? '', /npm-pack:\$AGENT_SYSTEM_PACKAGE/u);
    assert.match(candidate?.run ?? '', /--accept-capabilities/u);
    assert.match(candidate?.run ?? '', /plugins inspect agent-system --runtime --json/u);
    assert.match(candidate?.run ?? '', /openclaw-gateway start/u);
    assert.match(candidate?.run ?? '', /openclaw gateway call agents\.list/u);
    assert.match(candidate?.run ?? '', /\.agents \| type == "array"/u);
    assert.match(candidate?.run ?? '', /openclaw-gateway stop/u);
    assert.ok(steps.indexOf(install!) < steps.indexOf(candidate!));
  });
});
