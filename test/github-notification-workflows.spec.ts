import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

interface WorkflowStep {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
}

interface CallerJob {
  concurrency?: unknown;
  if?: string;
  name?: string;
  secrets?: Record<string, unknown>;
  strategy?: {
    'fail-fast'?: boolean;
    matrix?: Record<string, unknown>;
    'max-parallel'?: number;
  };
  uses?: string;
  with?: Record<string, unknown>;
}

interface CallerWorkflow {
  jobs?: { mock?: CallerJob; notifications?: CallerJob };
  on?: {
    pull_request?: unknown;
    workflow_dispatch?: {
      inputs?: Record<string, { options?: string[] }>;
    };
  };
  runName?: string;
}

interface ReusableWorkflow {
  jobs?: {
    notification?: {
      concurrency?: unknown;
      name?: string;
      steps?: WorkflowStep[];
      strategy?: unknown;
    };
  };
  on?: {
    workflow_call?: {
      inputs?: Record<string, unknown>;
      secrets?: Record<string, unknown>;
    };
  };
  runName?: string;
}

interface ExampleWorkflow {
  jobs?: {
    examples?: {
      strategy?: {
        matrix?: {
          example?: string[];
          os?: string[];
        };
      };
    };
  };
}

describe('github notification workflows', () => {
  it('should keep the manual dispatcher as one live matrix and one mock proof', async () => {
    const source = await readFile('.github/workflows/notification-tests.yml', 'utf8');
    const workflow = parse(source) as CallerWorkflow;
    const notifications = workflow.jobs?.notifications;
    const mock = workflow.jobs?.mock;
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};

    assert.equal(workflow.runName, undefined);
    assert.deepEqual(Object.keys(inputs), ['scenario']);
    assert.deepEqual(Object.keys(workflow.jobs ?? {}), ['notifications', 'mock']);
    assert.deepEqual(inputs.scenario?.options, [
      'assignment',
      'assignment-provider-proof',
      'implementation',
      'pr',
      'comment',
      'retirement',
      'all',
    ]);
    assert.equal(notifications?.uses, './.github/workflows/reusable-notification-test.yml');
    assert.equal(notifications?.name, undefined);
    assert.equal(notifications?.if, "inputs.scenario != 'assignment-provider-proof'");
    assert.equal(notifications?.concurrency, undefined);
    assert.equal(notifications?.strategy?.['fail-fast'], false);
    assert.equal(notifications?.strategy?.['max-parallel'], undefined);
    assert.deepEqual(Object.keys(notifications?.strategy?.matrix ?? {}), ['scenario']);
    assert.equal(notifications?.with?.provider, 'live');
    assert.equal(notifications?.with?.scenario, '${{ matrix.scenario }}');
    assert.equal(
      notifications?.secrets?.op_service_account_token,
      '${{ secrets.TANAAB_OP_TESTVAULT }}',
    );
    assert.equal(
      notifications?.secrets?.openai_api_key,
      '${{ secrets.TANAAB_ALTERNATE_MALE_KEY }}',
    );
    assert.equal(mock?.uses, './.github/workflows/reusable-notification-test.yml');
    assert.equal(
      mock?.if,
      "inputs.scenario == 'assignment-provider-proof' || inputs.scenario == 'all'",
    );
    assert.equal(mock?.strategy, undefined);
    assert.deepEqual(mock?.with, {
      provider: 'mock',
      scenario: 'assignment-provider-proof',
    });
    assert.deepEqual(mock?.secrets, {
      op_service_account_token: '${{ secrets.TANAAB_OP_TESTVAULT }}',
    });
  });

  it('should keep the pull request dispatcher fixed to the trusted mock proof', async () => {
    const source = await readFile('.github/workflows/pr-notification-tests.yml', 'utf8');
    const workflow = parse(source) as CallerWorkflow;
    const notifications = workflow.jobs?.notifications;

    assert.equal(workflow.runName, undefined);
    assert.equal(Object.hasOwn(workflow.on ?? {}, 'pull_request'), true);
    assert.match(notifications?.if ?? '', /head\.repo\.full_name == github\.repository/u);
    assert.match(notifications?.if ?? '', /github\.actor != 'dependabot\[bot\]'/u);
    assert.equal(notifications?.uses, './.github/workflows/reusable-notification-test.yml');
    assert.equal(notifications?.name, undefined);
    assert.equal(notifications?.concurrency, undefined);
    assert.equal(notifications?.strategy, undefined);
    assert.deepEqual(notifications?.with, {
      provider: 'mock',
      scenario: 'assignment-provider-proof',
    });
    assert.deepEqual(notifications?.secrets, {
      op_service_account_token: '${{ secrets.TANAAB_OP_TESTVAULT }}',
    });
  });

  it('should keep one credential-scoped reusable notification job', async () => {
    const source = await readFile('.github/workflows/reusable-notification-test.yml', 'utf8');
    const workflow = parse(source) as ReusableWorkflow;
    const notification = workflow.jobs?.notification;
    const steps = notification?.steps ?? [];
    const leiaStep = steps.find((step) => step.name === 'Run Leia-backed notification scenario');
    const credentialSteps = steps.filter((step) => JSON.stringify(step).includes('secrets.'));

    assert.equal(workflow.runName, undefined);
    assert.deepEqual(Object.keys(workflow.on?.workflow_call?.inputs ?? {}), [
      'provider',
      'scenario',
    ]);
    assert.deepEqual(Object.keys(workflow.on?.workflow_call?.secrets ?? {}), [
      'openai_api_key',
      'op_service_account_token',
    ]);
    assert.equal(notification?.name, undefined);
    assert.equal(notification?.concurrency, undefined);
    assert.equal(notification?.strategy, undefined);
    assert.deepEqual(credentialSteps, [leiaStep]);
    assert.equal(leiaStep?.env?.NOTIFICATION_MODEL_PROVIDER, '${{ inputs.provider }}');
    assert.equal(leiaStep?.env?.OPENAI_API_KEY, '${{ secrets.openai_api_key }}');
    assert.equal(
      leiaStep?.env?.OP_SERVICE_ACCOUNT_TOKEN,
      '${{ secrets.op_service_account_token }}',
    );
    assert.match(leiaStep?.run ?? '', /scenarios\/issue-work-\$\{\{ inputs\.scenario \}\}/u);
    assert.match(source, /HOMEBREW_NO_AUTO_UPDATE= brew update-if-needed/u);
    assert.match(source, /bun install --frozen-lockfile --ignore-scripts/u);
  });

  it('should keep one credential free example smoke during scenario conversion', async () => {
    const source = await readFile('.github/workflows/pr-examples-tests.yml', 'utf8');
    const workflow = parse(source) as ExampleWorkflow;

    assert.deepEqual(workflow.jobs?.examples?.strategy?.matrix, {
      example: ['validate'],
      os: ['ubuntu-24.04'],
    });
    assert.match(source, /Restore the full matrix after the proof is green/u);
  });
});
