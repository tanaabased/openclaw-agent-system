import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

interface WorkflowStep {
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
}

interface CompatibilityWorkflow {
  env?: Record<string, string>;
  jobs?: {
    compatibility?: {
      'runs-on'?: string;
      steps?: WorkflowStep[];
    };
  };
  on?: {
    pull_request?: unknown;
    push?: { branches?: string[] };
    workflow_dispatch?: unknown;
  };
}

describe('openclaw compatibility workflow', () => {
  it('should rehearse the historical baseline and coordinated target cutover', async () => {
    const source = await readFile('.github/workflows/pr-openclaw-compatibility.yml', 'utf8');
    const workflow = parse(source) as CompatibilityWorkflow;
    const job = workflow.jobs?.compatibility;
    const steps = job?.steps ?? [];
    const historical = steps.find(
      (step) => step.name === 'Verify historical core and plugin baseline',
    );
    const cutover = steps.find((step) => step.name === 'Stage coordinated core cutover');
    const candidate = steps.find((step) => step.name === 'Verify candidate plugin and Gateway');

    assert.ok(workflow.on && Object.hasOwn(workflow.on, 'pull_request'));
    assert.ok(workflow.on && Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.deepEqual(workflow.on?.push?.branches, ['main']);
    assert.equal(workflow.env?.OPENCLAW_STATE_DIR, '${{ runner.temp }}/openclaw-state');
    assert.equal(job?.['runs-on'], 'ubuntu-24.04');
    assert.match(source, /openclaw@2026\.7\.1-2/u);
    assert.match(source, /@tanaab\/openclaw-agent-system@0\.5\.3/u);
    assert.match(historical?.run ?? '', /openclaw-gateway start/u);
    assert.match(cutover?.run ?? '', /plugins disable agent-system/u);
    assert.match(cutover?.run ?? '', /openclaw@2026\.9\.3/u);
    assert.ok(
      (cutover?.run ?? '').indexOf('plugins disable agent-system') <
        (cutover?.run ?? '').indexOf('openclaw@2026.9.3'),
    );
    assert.match(candidate?.run ?? '', /npm-pack:\$AGENT_SYSTEM_PACKAGE/u);
    assert.match(candidate?.run ?? '', /plugins inspect agent-system --runtime --json/u);
    assert.match(candidate?.run ?? '', /openclaw-gateway start/u);
    assert.match(candidate?.run ?? '', /openclaw gateway call agents\.list/u);
    assert.match(candidate?.run ?? '', /openclaw-gateway stop/u);
    assert.ok(steps.indexOf(historical!) < steps.indexOf(cutover!));
    assert.ok(steps.indexOf(cutover!) < steps.indexOf(candidate!));
  });
});
