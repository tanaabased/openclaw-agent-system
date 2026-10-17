import refreshNotificationsAgentSystem from '../channels/github/cli/refresh.ts';
import type { GitHubNotificationRefreshResult } from '../channels/github/cli/contracts.ts';
import type OpenClawNotifications from '../agent/openclaw-notifications.ts';
import { createCliStyles } from '../cli/output.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

export const refreshFixtureAgent = 'Agent-MixedCase';
export const refreshFixtureRepository =
  'MixedCaseOwner/Long-Notification-Repository-With-MixedCase';
export const refreshFixtureNames = ['queued', 'already-running', 'disabled', 'failed'] as const;
type RefreshFixtureName = (typeof refreshFixtureNames)[number];

export function refreshFixtureResult(name: RefreshFixtureName): GitHubNotificationRefreshResult {
  return {
    agentId: refreshFixtureAgent,
    baselineAt: Date.parse('2026-09-01T00:00:00.000Z'),
    code:
      name === 'queued'
        ? 'github-notification-refresh-queued'
        : name === 'already-running'
          ? 'github-notification-refresh-already-running'
          : name === 'disabled'
            ? 'github-notification-disabled'
            : 'github-notification-refresh-outcome-uncertain',
    status: name === 'queued' ? 'queued' : name === 'already-running' ? 'skipped' : 'failed',
    ...(name === 'queued' ? { runId: 'NativeRun-MixedCase' } : {}),
  };
}

export async function captureRefreshFixture(
  name: RefreshFixtureName,
  {
    json = false,
    columns = 120,
    color = false,
    warnings = false,
    itemKind = undefined,
    repository = undefined,
    itemNumber = undefined,
    timeoutSeconds = undefined,
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
  const calls: Parameters<OpenClawNotifications['refresh']>[2][] = [];
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
    nativeService: {
      async refresh(_manifest, _workspace, input) {
        calls.push(input);
        return result;
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
