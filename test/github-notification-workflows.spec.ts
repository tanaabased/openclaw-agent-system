import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from 'yaml';

import { githubNotificationAssignmentCandidate } from '../scenarios/issue-work-assignment/model-fixture.ts';

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
      inputs?: Record<string, { default?: string; options?: string[] }>;
    };
  };
  runName?: string;
}

interface ReusableWorkflow {
  env?: Record<string, unknown>;
  jobs?: {
    notification?: {
      concurrency?: unknown;
      name?: string;
      'runs-on'?: string;
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
    assert.deepEqual(Object.keys(inputs), ['scenario', 'runner']);
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
    assert.equal(inputs.runner?.default, 'ubuntu-24.04');
    assert.deepEqual(inputs.runner?.options, ['ubuntu-24.04', 'macos-26']);
    assert.equal(notifications?.uses, './.github/workflows/reusable-notification-test.yml');
    assert.equal(notifications?.name, undefined);
    assert.equal(notifications?.if, "inputs.scenario != 'assignment-provider-proof'");
    assert.equal(notifications?.concurrency, undefined);
    assert.equal(notifications?.strategy?.['fail-fast'], false);
    assert.equal(notifications?.strategy?.['max-parallel'], undefined);
    assert.deepEqual(Object.keys(notifications?.strategy?.matrix ?? {}), ['scenario']);
    assert.equal(notifications?.with?.provider, 'live');
    assert.equal(notifications?.with?.runner, '${{ inputs.runner }}');
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
      runner: '${{ inputs.runner }}',
      scenario: 'assignment-provider-proof',
    });
    assert.deepEqual(mock?.secrets, {
      op_service_account_token: '${{ secrets.TANAAB_OP_TESTVAULT }}',
    });
  });

  it('should run the converted pull request scenarios through one mock matrix', async () => {
    const source = await readFile('.github/workflows/pr-notification-tests.yml', 'utf8');
    const workflow = parse(source) as CallerWorkflow;
    const notifications = workflow.jobs?.notifications;

    assert.equal(workflow.runName, undefined);
    assert.equal(Object.hasOwn(workflow.on ?? {}, 'pull_request'), true);
    assert.equal(notifications?.if, undefined);
    assert.equal(notifications?.uses, './.github/workflows/reusable-notification-test.yml');
    assert.equal(notifications?.name, undefined);
    assert.equal(notifications?.concurrency, undefined);
    assert.equal(notifications?.strategy?.['fail-fast'], false);
    assert.equal(notifications?.strategy?.['max-parallel'], undefined);
    assert.deepEqual(notifications?.strategy?.matrix, {
      scenario: ['assignment', 'assignment-provider-proof'],
    });
    assert.deepEqual(notifications?.with, {
      provider: 'mock',
      runner: 'ubuntu-24.04',
      scenario: '${{ matrix.scenario }}',
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
      'runner',
      'scenario',
    ]);
    assert.deepEqual(Object.keys(workflow.on?.workflow_call?.secrets ?? {}), [
      'openai_api_key',
      'op_service_account_token',
    ]);
    assert.equal(notification?.name, undefined);
    assert.equal(notification?.concurrency, undefined);
    assert.equal(notification?.strategy, undefined);
    assert.equal(notification?.['runs-on'], '${{ inputs.runner }}');
    assert.deepEqual(credentialSteps, [leiaStep]);
    assert.equal(workflow.env?.OPENAI_MODEL, 'gpt-5.4-nano');
    assert.equal(
      leiaStep?.env?.NOTIFICATION_MODEL,
      "${{ inputs.provider == 'live' && format('openai/{0}', env.OPENAI_MODEL) || 'aimock/gpt-5.5' }}",
    );
    assert.equal(
      leiaStep?.env?.DBUS_SESSION_BUS_ADDRESS,
      "${{ runner.os == 'Linux' && format('unix:path={0}/secret-service-bus', runner.temp) || '' }}",
    );
    assert.equal(
      leiaStep?.env?.DEFAULT_CREDENTIAL_STORE,
      "${{ runner.os == 'macOS' && 'keychain' || 'secret-service' }}",
    );
    assert.equal(leiaStep?.env?.OPENAI_API_KEY, '${{ secrets.openai_api_key }}');
    assert.equal(
      leiaStep?.env?.OP_SERVICE_ACCOUNT_TOKEN,
      '${{ secrets.op_service_account_token }}',
    );
    assert.match(leiaStep?.run ?? '', /scenarios\/issue-work-\$\{\{ inputs\.scenario \}\}/u);
    assert.match(source, /HOMEBREW_NO_AUTO_UPDATE= brew update-if-needed/u);
    assert.match(source, /bun install --frozen-lockfile --ignore-scripts/u);
  });

  it('should keep assignment as one provider-neutral lifecycle scenario', async () => {
    const source = await readFile('scenarios/issue-work-assignment/README.md', 'utf8');
    const proofSource = await readFile(
      'scenarios/issue-work-assignment-provider-proof/README.md',
      'utf8',
    );
    const expectedEvidence = JSON.parse(
      await readFile('scenarios/issue-work-assignment/expected-evidence.json', 'utf8'),
    ) as { scenario?: string };

    assert.match(source, /openclaw-notification-setup prepare/u);
    assert.match(source, /openclaw-notification-setup evidence/u);
    assert.match(source, /openclaw-notification-setup stop/u);
    assert.match(source, /--model "\$NOTIFICATION_MODEL"/u);
    assert.match(source, /--scenario assignment/u);
    assert.doesNotMatch(source, /NOTIFICATION_MODEL_PROVIDER|models\.providers\.aimock/u);
    assert.match(proofSource, /openclaw-notification-setup prepare/u);
    assert.match(proofSource, /openclaw-notification-setup evidence/u);
    assert.match(proofSource, /openclaw-notification-setup stop/u);
    assert.doesNotMatch(proofSource, /models\.providers\.aimock/u);
    assert.match(source, /length\) <= 800/u);
    assert.equal(source.includes(githubNotificationAssignmentCandidate), false);
    assert.equal(expectedEvidence.scenario, 'assignment');
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
