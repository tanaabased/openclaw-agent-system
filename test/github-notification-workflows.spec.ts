import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

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
  name?: string;
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
  it('should keep the manual dispatcher as one live scenario matrix', async () => {
    const source = await readFile('.github/workflows/notification-tests.yml', 'utf8');
    const workflow = parse(source) as CallerWorkflow;
    const notifications = workflow.jobs?.notifications;
    const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};

    assert.equal(workflow.name, 'Notification Tests');
    assert.equal(workflow.runName, undefined);
    assert.deepEqual(Object.keys(inputs), ['scenario', 'runner']);
    assert.deepEqual(Object.keys(workflow.jobs ?? {}), ['notifications']);
    assert.deepEqual(inputs.scenario?.options, [
      'assignment',
      'implementation',
      'pr-handoff',
      'pr-continuation',
      'pr-retirement',
      'comment',
      'retirement',
      'all',
    ]);
    assert.equal(inputs.runner?.default, 'ubuntu-24.04');
    assert.deepEqual(inputs.runner?.options, ['ubuntu-24.04', 'macos-26']);
    assert.equal(notifications?.uses, './.github/workflows/reusable-notification-test.yml');
    assert.equal(notifications?.name, undefined);
    assert.equal(notifications?.if, undefined);
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
  });

  it('should run the converted pull request scenarios through one mock matrix', async () => {
    const source = await readFile('.github/workflows/pr-notification-tests.yml', 'utf8');
    const workflow = parse(source) as CallerWorkflow;
    const notifications = workflow.jobs?.notifications;

    assert.equal(workflow.name, 'Notification Tests');
    assert.equal(workflow.runName, undefined);
    assert.equal(Object.hasOwn(workflow.on ?? {}, 'pull_request'), true);
    assert.equal(notifications?.if, undefined);
    assert.equal(notifications?.uses, './.github/workflows/reusable-notification-test.yml');
    assert.equal(notifications?.name, '${{ matrix.scenario }}');
    assert.equal(notifications?.concurrency, undefined);
    assert.equal(notifications?.strategy?.['fail-fast'], false);
    assert.equal(notifications?.strategy?.['max-parallel'], undefined);
    assert.deepEqual(notifications?.strategy?.matrix, {
      scenario: [
        'assignment',
        'implementation',
        'pr-handoff',
        'pr-continuation',
        'pr-retirement',
        'comment',
        'retirement',
      ],
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
    const diagnosticsStep = steps.find((step) => step.name === 'RUNNING A LEVEL THREE DIAGNOSTICS');
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
    assert.equal(notification?.name, "${{ inputs.provider == 'mock' && 'mock-ai' || 'live-ai' }}");
    assert.equal(notification?.concurrency, undefined);
    assert.equal(notification?.strategy, undefined);
    assert.equal(notification?.['runs-on'], '${{ inputs.runner }}');
    assert.ok(diagnosticsStep);
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
    const expectedEvidence = JSON.parse(
      await readFile('scenarios/issue-work-assignment/expected-evidence.json', 'utf8'),
    ) as { scenario?: string };

    assert.match(source, /openclaw-notification-setup prepare/u);
    assert.match(source, /openclaw-notification-setup evidence/u);
    assert.match(source, /openclaw-notification-setup stop/u);
    assert.match(source, /--model "\$NOTIFICATION_MODEL"/u);
    assert.match(source, /--scenario assignment/u);
    assert.doesNotMatch(source, /NOTIFICATION_MODEL_PROVIDER|models\.providers\.aimock/u);
    assert.match(source, /length\) <= 800/u);
    assert.equal(source.includes(githubNotificationAssignmentCandidate), false);
    assert.equal(expectedEvidence.scenario, 'assignment');
  });

  it('should keep retirement as one provider-neutral lifecycle scenario', async () => {
    const source = await readFile('scenarios/issue-work-retirement/README.md', 'utf8');
    const expectedEvidence = JSON.parse(
      await readFile('scenarios/issue-work-retirement/expected-evidence.json', 'utf8'),
    ) as { scenario?: string };

    assert.match(source, /openclaw-notification-setup prepare/u);
    assert.match(source, /openclaw-notification-setup evidence/u);
    assert.match(source, /openclaw-notification-setup stop/u);
    assert.match(source, /--model "\$NOTIFICATION_MODEL"/u);
    assert.match(source, /--scenario retirement/u);
    assert.doesNotMatch(source, /openclaw-setup|models\.providers\.aimock/u);
    assert.ok(
      source.indexOf('--for retired') < source.indexOf('openclaw-notification-setup evidence'),
    );
    assert.equal(expectedEvidence.scenario, 'retirement');
  });

  it('should keep implementation as one provider-neutral lifecycle scenario', async () => {
    const source = await readFile('scenarios/issue-work-implementation/README.md', 'utf8');
    const expectedEvidence = JSON.parse(
      await readFile('scenarios/issue-work-implementation/expected-evidence.json', 'utf8'),
    ) as { scenario?: string };

    assert.match(source, /openclaw-notification-setup prepare/u);
    assert.match(source, /openclaw-notification-setup evidence/u);
    assert.match(source, /openclaw-notification-setup stop/u);
    assert.match(source, /--model "\$NOTIFICATION_MODEL"/u);
    assert.match(source, /--scenario implementation/u);
    assert.doesNotMatch(source, /openclaw-setup|models\.providers\.aimock/u);
    assert.match(source, /rev-list --count "\$base_sha\.\.HEAD"/u);
    assert.match(source, /test "\$commit_count" -eq 1/u);
    assert.match(source, /test "\$remote_sha" = "\$head_sha"/u);
    assert.equal(expectedEvidence.scenario, 'implementation');
  });

  it('should isolate pull request handoff as one provider-neutral lifecycle scenario', async () => {
    const source = await readFile('scenarios/issue-work-pr-handoff/README.md', 'utf8');
    const expectedEvidence = JSON.parse(
      await readFile('scenarios/issue-work-pr-handoff/expected-evidence.json', 'utf8'),
    ) as { finalResponseCount?: number; requestCount?: number; scenario?: string };

    assert.match(source, /openclaw-notification-setup prepare/u);
    assert.match(source, /openclaw-notification-setup evidence/u);
    assert.match(source, /openclaw-notification-setup stop/u);
    assert.match(source, /--model "\$NOTIFICATION_MODEL"/u);
    assert.match(source, /--scenario pr-handoff/u);
    assert.doesNotMatch(source, /openclaw-setup|models\.providers\.aimock/u);
    assert.match(source, /\.body \| contains\("Closes #"/u);
    assert.match(source, /index\("emoriwan"\) != null/u);
    assert.match(source, /agent-system-github-publication:pull-request-handoff/u);
    assert.match(source, /contains\("## Pull request opened"\)/u);
    assert.doesNotMatch(source, /pr comment|--json mergedAt,state/u);
    assert.equal(expectedEvidence.scenario, 'pr-handoff');
    assert.equal(expectedEvidence.requestCount, 8);
    assert.equal(expectedEvidence.finalResponseCount, 3);
  });

  it('should isolate pull request continuation and recovery as one lifecycle scenario', async () => {
    const source = await readFile('scenarios/issue-work-pr-continuation/README.md', 'utf8');
    const expectedEvidence = JSON.parse(
      await readFile('scenarios/issue-work-pr-continuation/expected-evidence.json', 'utf8'),
    ) as { finalResponseCount?: number; requestCount?: number; scenario?: string };

    assert.match(source, /openclaw-notification-setup prepare/u);
    assert.match(source, /openclaw-notification-setup evidence/u);
    assert.match(source, /openclaw-notification-setup stop/u);
    assert.match(source, /--model "\$NOTIFICATION_MODEL"/u);
    assert.match(source, /--scenario pr-continuation/u);
    assert.doesNotMatch(source, /openclaw-setup|models\.providers\.aimock/u);
    assert.match(source, /agent-system-github-publication:github-reply/u);
    assert.match(source, /pr comment/u);
    assert.match(
      source,
      /--json mergedAt,state \| jq -e '\.state == "CLOSED" and \.mergedAt == null'/u,
    );
    assert.match(
      source,
      /\.disposition == "approved" and \.reasonCode == "assignment-approved" and \.stage == "prepared" and \.worktree == "ready"/u,
    );
    const closureAssertionIndex = source.indexOf('--json mergedAt,state');
    const activeStatusIndex = source.indexOf('.disposition == "approved"');
    const evidenceIndex = source.indexOf('openclaw-notification-setup evidence');
    assert.ok(closureAssertionIndex < activeStatusIndex);
    assert.ok(activeStatusIndex < evidenceIndex);
    assert.equal(expectedEvidence.scenario, 'pr-continuation');
    assert.equal(expectedEvidence.requestCount, 10);
    assert.equal(expectedEvidence.finalResponseCount, 4);
  });

  it('should isolate pull request merge retirement as one lifecycle scenario', async () => {
    const source = await readFile('scenarios/issue-work-pr-retirement/README.md', 'utf8');
    const expectedEvidence = JSON.parse(
      await readFile('scenarios/issue-work-pr-retirement/expected-evidence.json', 'utf8'),
    ) as { finalResponseCount?: number; requestCount?: number; scenario?: string };

    assert.match(source, /openclaw-notification-setup prepare/u);
    assert.match(source, /openclaw-notification-setup evidence/u);
    assert.match(source, /openclaw-notification-setup stop/u);
    assert.match(source, /--model "\$NOTIFICATION_MODEL"/u);
    assert.match(source, /--scenario pr-retirement/u);
    assert.doesNotMatch(source, /openclaw-setup|models\.providers\.aimock/u);
    assert.match(source, /agent-system-github-publication:pull-request-handoff/u);
    assert.match(source, /agent-system-pr-retirement-base-/u);
    assert.match(source, /pr edit "\$pull_request_number".*--base "\$retirement_base"/u);
    assert.match(source, /--json mergeable --jq \.mergeable/u);
    assert.match(source, /test "\$mergeable" = MERGEABLE/u);
    assert.match(source, /pr merge "\$pull_request_number".*--merge/u);
    assert.match(source, /\.mergedBy\.login == "emoriwan"/u);
    assert.match(source, /--json state --jq \.state \| grep -Fx OPEN/u);
    assert.match(
      source,
      /\.disposition == "retired" and \.reasonCode == "pull-request-merged" and \.stage == "retired"/u,
    );
    assert.match(
      source,
      /\.cleanup\.status == "completed" and \.cleanup\.session == "archived" and \.cleanup\.worktree == "removed"/u,
    );
    assert.equal(source.match(/--for retired/gu)?.length, 2);
    const mergeAssertionIndex = source.indexOf('.mergedBy.login == "emoriwan"');
    const retirementAssertionIndex = source.indexOf('.reasonCode == "pull-request-merged"');
    const cleanupAssertionIndex = source.indexOf('.cleanup.status == "completed"');
    const evidenceIndex = source.indexOf('openclaw-notification-setup evidence');
    assert.ok(mergeAssertionIndex < retirementAssertionIndex);
    assert.ok(retirementAssertionIndex < cleanupAssertionIndex);
    assert.ok(cleanupAssertionIndex < evidenceIndex);
    assert.equal(expectedEvidence.scenario, 'pr-retirement');
    assert.equal(expectedEvidence.requestCount, 8);
    assert.equal(expectedEvidence.finalResponseCount, 3);
  });

  it('should keep comment continuation as one provider-neutral lifecycle scenario', async () => {
    const source = await readFile('scenarios/issue-work-comment/README.md', 'utf8');
    const expectedEvidence = JSON.parse(
      await readFile('scenarios/issue-work-comment/expected-evidence.json', 'utf8'),
    ) as { scenario?: string };

    assert.match(source, /openclaw-notification-setup prepare/u);
    assert.match(source, /openclaw-notification-setup evidence/u);
    assert.match(source, /openclaw-notification-setup stop/u);
    assert.match(source, /--model "\$NOTIFICATION_MODEL"/u);
    assert.match(source, /--scenario comment/u);
    assert.doesNotMatch(source, /openclaw-setup|models\.providers\.aimock/u);
    assert.match(source, /agent-system-github-publication:github-reply/u);
    assert.match(source, /contains\("@emoriwan"\) and contains\(\$token\)/u);
    assert.equal(expectedEvidence.scenario, 'comment');
  });

  it('should keep every general example in the non-notification pull request matrix', async () => {
    const source = await readFile('.github/workflows/pr-examples-tests.yml', 'utf8');
    const workflow = parse(source) as ExampleWorkflow;
    const examples = workflow.jobs?.examples?.strategy?.matrix?.example ?? [];
    const exampleDirectories = (await readdir('examples', { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(workflow.jobs?.examples?.strategy?.matrix, {
      example: [
        'install',
        'validate',
        'doctor',
        'agent',
        'identity',
        'path',
        'env',
        'credentials',
        'git',
        'worktree',
        'github',
        'routing',
        'tool',
        'security',
      ],
      os: ['macos-26', 'ubuntu-24.04'],
    });
    assert.deepEqual(exampleDirectories, [...examples].sort());
    assert.match(source, /name: RUNNING A LEVEL THREE DIAGNOSTICS/u);
  });
});
