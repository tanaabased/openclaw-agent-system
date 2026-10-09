import refreshNotificationsAgentSystem from '../channels/github/cli/refresh.ts';
import type {
  GitHubNotificationMonitorRunOptions,
  GitHubNotificationMonitorRunResult,
} from '../channels/github/intake/monitor/service.ts';
import { createCliStyles } from '../cli/output.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

export const refreshFixtureAgent = 'Agent-MixedCase';
export const refreshFixtureRepository =
  'MixedCaseOwner/Long-Notification-Repository-With-MixedCase';
export const refreshFixtureNames = [
  'baseline-establishment',
  'no-new-work',
  'filtered',
  'throttled',
  'partial-failure',
  'disabled',
  'failed',
] as const;
type RefreshFixtureName = (typeof refreshFixtureNames)[number];

export function refreshFixtureResult(name: RefreshFixtureName): GitHubNotificationMonitorRunResult {
  const baselineAt = Date.parse('2026-09-01T00:00:00.000Z');
  const ready = {
    agentId: refreshFixtureAgent,
    approved: 0,
    baseline: 3,
    baselineAt,
    baselineEstablished: false,
    code: 'github-notification-poll-complete',
    duplicates: 0,
    nextPollAt: baselineAt + 60_000,
    rejected: 0,
    retired: 0,
    status: 'completed' as const,
  };
  switch (name) {
    case 'baseline-establishment':
      return {
        ...ready,
        baselineEstablished: true,
        code: 'github-notification-baseline-established',
      };
    case 'filtered':
      return { ...ready, approved: 1 };
    case 'throttled':
      return {
        agentId: refreshFixtureAgent,
        baselineAt,
        code: 'github-notification-provider-throttle-active',
        diagnosticCode: 'github-notification-rate-limited',
        nextPollAt: baselineAt + 60_000,
        retryAt: baselineAt + 120_000,
        status: 'skipped',
      };
    case 'partial-failure':
      return {
        ...ready,
        approved: 1,
        code: 'github-notification-poll-partial',
        itemFailures: [
          {
            repository: refreshFixtureRepository,
            itemType: 'issue',
            number: 12,
            stage: 'permission-check',
            cause: 'repository-permission-denied',
          },
          {
            repository: 'OtherOwner/Second-Repository',
            itemType: 'pull-request',
            number: 34,
            stage: 'permission-check',
            cause: 'repository-permission-denied',
          },
        ],
      };
    case 'disabled':
      return {
        agentId: refreshFixtureAgent,
        code: 'github-notification-disabled',
        status: 'skipped',
      };
    case 'failed':
      return {
        agentId: refreshFixtureAgent,
        baselineAt,
        code: 'github-notification-request-failed',
        diagnosticCode: 'ExternalDiagnostic-MixedCase',
        retryAt: baselineAt + 60_000,
        status: 'failed',
      };
    default:
      return ready;
  }
}

export async function captureRefreshFixture(
  name: RefreshFixtureName,
  {
    json = false,
    columns = 120,
    color = false,
    warnings = false,
    itemKind = name === 'filtered' ? 'pull-request' : undefined,
    repository = name === 'filtered' ? refreshFixtureRepository : undefined,
    itemNumber = name === 'filtered' ? '12' : undefined,
    timeoutSeconds = name === 'filtered' ? '12' : undefined,
  }: {
    json?: boolean;
    columns?: number;
    color?: boolean;
    warnings?: boolean;
    itemKind?: string;
    repository?: string;
    itemNumber?: string;
    timeoutSeconds?: string;
  } = {},
) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const calls: GitHubNotificationMonitorRunOptions[] = [];
  const loads: string[] = [];
  let exitCode = 0;
  const result = refreshFixtureResult(name);
  const manifest: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
    status: 'loaded',
    scope: { workspaceDir: '/Fixture/Workspace' },
    path: '/Fixture/Workspace/agent.yaml',
    digest: 'fixture',
    manifest: { schemaVersion: 1, agent: { id: refreshFixtureAgent } },
    diagnostics: warnings
      ? [
          {
            code: 'manifest-shadowed',
            severity: 'warning',
            message: 'External Warning: MixedCase.yaml is shadowed.',
          },
        ]
      : [],
    validationChecks: [],
  };
  await refreshNotificationsAgentSystem({
    agentId: refreshFixtureAgent,
    itemKind,
    itemNumber,
    repository,
    timeoutSeconds,
    json,
    manifestService: {
      async loadForAgentId(agentId) {
        loads.push(agentId);
        return manifest;
      },
      async loadForCommandDirectory() {
        throw new Error('fixture uses selected agent');
      },
    },
    monitorService: {
      async runOnce(input = {}) {
        if ('aborted' in input) throw new Error('fixture refresh unexpectedly aborted');
        calls.push(input);
        return [result];
      },
    },
    output: {
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
    },
    setExitCode: (code) => {
      exitCode = code;
    },
    styles: createCliStyles(color ? { FORCE_COLOR: '3' } : { NO_COLOR: '', FORCE_COLOR: '3' }),
    terminalColumns: columns,
    workspaceDir: '/Fixture/Workspace',
  });
  return { calls, events, exitCode, loads, result };
}
