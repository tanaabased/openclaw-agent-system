import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

interface WorkflowStep {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
}

interface NotificationWorkflow {
  jobs?: {
    notifications?: {
      concurrency?: { group?: string };
      if?: string;
      steps?: WorkflowStep[];
      strategy?: {
        matrix?: {
          lifecycle?: string;
          mode?: string;
          repeat?: string;
          scenario?: string;
        };
      };
    };
  };
  on?: {
    pull_request?: unknown;
    workflow_dispatch?: {
      inputs?: {
        scenario?: { options?: string[] };
      };
    };
  };
}

describe('github notification provider proof workflow', () => {
  it('should repeat the mock proof on trusted pull requests without a live model credential', async () => {
    const source = await readFile('.github/workflows/notification-tests.yml', 'utf8');
    const workflow = parse(source) as NotificationWorkflow;
    const notifications = workflow.jobs?.notifications;
    const mockStep = notifications?.steps?.find(
      (step) => step.name === 'Run mock-provider Leia-backed notification proof',
    );
    const liveStep = notifications?.steps?.find(
      (step) => step.name === 'Run live Leia-backed notification scenario',
    );

    assert.ok(
      workflow.on?.workflow_dispatch?.inputs?.scenario?.options?.includes(
        'assignment-provider-proof',
      ),
    );
    assert.equal(Object.hasOwn(workflow.on ?? {}, 'pull_request'), true);
    assert.match(notifications?.if ?? '', /head\.repo\.full_name == github\.repository/u);
    assert.match(notifications?.if ?? '', /github\.actor != 'dependabot\[bot\]'/u);
    assert.match(notifications?.strategy?.matrix?.lifecycle ?? '', /\["issue"\]/u);
    assert.match(notifications?.strategy?.matrix?.mode ?? '', /\["work"\]/u);
    assert.match(notifications?.strategy?.matrix?.scenario ?? '', /assignment-provider-proof/u);
    assert.match(notifications?.strategy?.matrix?.repeat ?? '', /\[1,2\]/u);
    assert.match(notifications?.concurrency?.group ?? '', /aimock-notification-proof/u);
    assert.equal(mockStep?.if, "matrix.scenario == 'assignment-provider-proof'");
    assert.equal(mockStep?.env?.OPENAI_API_KEY, undefined);
    assert.equal(mockStep?.env?.OPENAI_MODEL, undefined);
    assert.equal(mockStep?.env?.OP_SERVICE_ACCOUNT_TOKEN, '${{ secrets.TANAAB_OP_TESTVAULT }}');
    assert.match(
      mockStep?.run ?? '',
      /scenarios\/\$\{\{ matrix\.lifecycle \}\}-\$\{\{ matrix\.mode \}\}/u,
    );
    assert.equal(liveStep?.if, "matrix.scenario != 'assignment-provider-proof'");
    assert.equal(liveStep?.env?.OPENAI_API_KEY, '${{ secrets.TANAAB_ALTERNATE_MALE_KEY }}');
  });

  it('should leave the live issue example out of pull request validation', async () => {
    const source = await readFile('.github/workflows/pr-examples-tests.yml', 'utf8');
    assert.doesNotMatch(source, /^\s+example: issue$/mu);
    assert.match(source, /live issue example stays paused/u);
  });
});
