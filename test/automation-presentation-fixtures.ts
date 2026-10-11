import { AutomationError } from '../agent/automation-gateway.ts';
import type AutomationService from '../agent/automation-service.ts';
import automationList from '../cli/automation-list.ts';
import automationRun from '../cli/automation-run.ts';
import automationRuns from '../cli/automation-runs.ts';
import automationSync from '../cli/automation-sync.ts';
import { createCliStyles, writeCliDiagnosticNotices } from '../cli/output.ts';
import presentCliCommand from '../cli/presentation.ts';
import type { AgentSystemLifecycleFinding } from '../core/lifecycle-registry.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

type ListResult = Awaited<ReturnType<AutomationService['list']>>;
type Job = ListResult['jobs'][number];

function finding(
  id: string,
  status: AgentSystemLifecycleFinding['status'],
  code: string,
): AgentSystemLifecycleFinding {
  return {
    component: 'automations',
    stepId: id,
    status,
    code,
    message: `Automation ${id}: ${code}.`,
  };
}

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    declared: true,
    enabled: true,
    applicable: true,
    nativeId: `Native-${id}`,
    nativeEnabled: true,
    routing: 'isolated',
    execution: 'ok',
    delivery: 'not-requested',
    removed: false,
    findings: [finding(id, 'healthy', 'automation-healthy')],
    ...overrides,
  };
}

// illustrative normalized data; real cli functions, no gateway or host operations.
export const automationListFixtures: Record<string, ListResult> = {
  aligned: {
    runtime: 'openclaw',
    workspaceDir: '/Workspace/Mixed',
    status: 'aligned',
    jobs: [
      job('review'),
      job('one-shot', {
        nativeEnabled: false,
        findings: [finding('one-shot', 'healthy', 'automation-completed')],
      }),
    ],
    findings: [],
  },
  attention: {
    runtime: 'openclaw',
    workspaceDir: '/Workspace/Mixed',
    status: 'attention',
    jobs: [
      job('missing', {
        nativeId: null,
        nativeEnabled: null,
        routing: 'persistent-pending',
        execution: 'unavailable',
        delivery: 'unavailable',
        findings: [finding('missing', 'drift', 'automation-missing')],
      }),
      job('paused-review', {
        enabled: false,
        findings: [finding('paused-review', 'drift', 'automation-drift')],
      }),
      job('failed-review', {
        execution: 'error',
        delivery: 'not-delivered',
        findings: [
          finding('failed-review', 'warning', 'automation-execution-failed'),
          finding('failed-review', 'warning', 'automation-delivery-failed'),
        ],
      }),
      job('safety-disabled', {
        nativeEnabled: false,
        findings: [finding('safety-disabled', 'blocked', 'automation-native-safety-disabled')],
      }),
    ],
    findings: [finding('scheduler', 'blocked', 'automation-scheduler-disabled')],
  },
  inactive: {
    runtime: 'openclaw',
    workspaceDir: '/Workspace/Mixed',
    status: 'aligned',
    jobs: [
      job('paused-review', {
        enabled: false,
        nativeEnabled: false,
        findings: [finding('paused-review', 'healthy', 'automation-disabled')],
      }),
      job('codex-only', {
        applicable: false,
        nativeEnabled: null,
        nativeId: null,
        execution: 'unavailable',
        delivery: 'unavailable',
        findings: [],
      }),
      job('retired', {
        declared: false,
        enabled: false,
        nativeEnabled: false,
        removed: true,
        findings: [finding('retired', 'healthy', 'automation-disabled')],
      }),
    ],
    findings: [],
  },
  empty: {
    runtime: 'openclaw',
    workspaceDir: '/Workspace/Mixed',
    status: 'aligned',
    jobs: [],
    findings: [],
  },
  unavailable: {
    runtime: 'openclaw',
    workspaceDir: '/Workspace/Mixed',
    status: 'attention',
    jobs: [
      job('review', {
        nativeEnabled: null,
        nativeId: null,
        execution: 'unavailable',
        delivery: 'unavailable',
        findings: [],
      }),
    ],
    findings: [finding('operator', 'manual', 'automation-requires-operator-sync')],
  },
};
for (const fixture of Object.values(automationListFixtures))
  fixture.findings.push(...fixture.jobs.flatMap(({ findings }) => findings));

export const automationSyncFixture = {
  outcomes: [
    {
      component: 'automations',
      stepId: 'review',
      status: 'updated' as const,
      code: 'automation-synchronized',
      message: 'Automation review is synchronized (persistent: Thread-Mixed).',
    },
  ],
  warnings: [
    { component: 'automations', code: 'FixtureWarning', message: 'External-Mixed warning' },
  ],
};
export const automationRunFixture = {
  runtime: 'openclaw',
  id: 'review',
  nativeId: 'Native-Mixed',
  status: 'queued' as const,
  runId: 'Run-Mixed',
  execution: 'unavailable',
  delivery: 'unavailable',
};
export const automationHistoryFixture = {
  runtime: 'openclaw',
  id: 'review',
  nativeId: 'Native-Mixed',
  status: 'ok',
  entries: [
    { ts: 1790812800000, runId: 'Run-Mixed', execution: 'error', delivery: 'not-delivered' },
    { ts: 1790812800001, execution: 'unavailable', delivery: 'unavailable' },
  ],
  total: 3,
  offset: 0,
  limit: 2,
  hasMore: true,
  nextOffset: 2,
};

export async function captureAutomationPreview(
  name: string,
  options: {
    columns?: number;
    environment?: NodeJS.ProcessEnv;
    json?: boolean;
    notices?: boolean;
  } = {},
) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const calls: string[] = [];
  let exitCode = 0;
  const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
    status: 'loaded',
    manifest: { schemaVersion: 1, agent: { id: 'Agent-Mixed' } },
    scope: { workspaceDir: '/Workspace/Mixed' },
    path: '/Workspace/Mixed/agent.yaml',
    digest: 'fixture',
    validationChecks: [],
    diagnostics: options.notices
      ? [{ code: 'FixtureWarning', severity: 'warning', message: 'MixedCaseWarning' }]
      : [],
  };
  const commandOptions = {
    workspaceDir: '/Discovery',
    json: options.json ?? false,
    styles: createCliStyles(options.environment ?? { NO_COLOR: '1' }),
    terminalColumns: options.columns ?? 160,
    output: {
      writeStdout: (text: string) => events.push({ stream: 'stdout', text }),
      writeStderr: (text: string) => events.push({ stream: 'stderr', text }),
    },
    setExitCode: (code: number) => {
      exitCode = code;
    },
    manifestService: {
      loadForAgentId: async () => loaded,
      loadForCommandDirectory: async () => loaded,
    },
    automations: {
      list: async () => {
        calls.push('list');
        if (name === 'failure') throw new AutomationError('automation-gateway-unavailable');
        return automationListFixtures[name]!;
      },
      reconcile: async () => {
        calls.push('reconcile');
        return automationSyncFixture;
      },
      run: async () => {
        calls.push('run');
        return name === 'disabled'
          ? {
              ...automationRunFixture,
              status: 'skipped' as const,
              reason: 'disabled',
              runId: undefined,
            }
          : name === 'skipped'
          ? {
              ...automationRunFixture,
              status: 'skipped' as const,
              reason: 'invalid-spec',
              runId: undefined,
            }
          : automationRunFixture;
      },
      runs: async () => {
        calls.push('runs');
        return name === 'history-empty'
          ? { ...automationHistoryFixture, entries: [], total: 0, hasMore: false, nextOffset: null }
          : automationHistoryFixture;
      },
    },
  };
  const command = presentCliCommand(async (presented: typeof commandOptions) => {
    if (options.notices)
      writeCliDiagnosticNotices(presented, [{ severity: 'notice', message: 'MixedCaseInfo' }]);
    if (name === 'sync') await automationSync(presented);
    else if (['run', 'skipped', 'disabled'].includes(name))
      await automationRun(presented, 'review');
    else if (name === 'history' || name === 'history-empty')
      await automationRuns(presented, 'review', { limit: 2, offset: 0 });
    else await automationList(presented);
  });
  await command(commandOptions);
  return {
    events,
    exitCode,
    calls,
    stdout: events
      .filter(({ stream }) => stream === 'stdout')
      .map(({ text }) => text)
      .join(''),
    stderr: events
      .filter(({ stream }) => stream === 'stderr')
      .map(({ text }) => text)
      .join(''),
  };
}
