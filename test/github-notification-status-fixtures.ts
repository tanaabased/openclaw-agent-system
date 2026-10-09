import statusNotificationsAgentSystem from '../channels/github/cli/status.ts';
import GitHubNotificationStatusService from '../channels/github/intake/monitor/status-service.ts';
import type { GitHubNotificationItemSelector } from '../channels/github/intake/monitor/status.ts';
import { createCliStyles } from '../cli/output.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import {
  approvedNotificationItem,
  approvedPullRequestNotificationItem,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

// illustrative data only; command and projection run against injected services.
export const statusFixtureAgent = 'Agent-MixedCase';
export const statusFixtureRepository = 'MixedCaseOwner/Long-Notification-Repository-With-MixedCase';
export const statusFixtureNames = [
  'empty',
  'healthy',
  'pending',
  'degraded',
  'cleanup',
  'filtered',
] as const;
export type StatusFixtureName = (typeof statusFixtureNames)[number];
export const statusFixtureSelector: GitHubNotificationItemSelector = {
  repository: statusFixtureRepository,
  itemType: 'issue',
  number: 12,
};

export function statusFixtureState(name: StatusFixtureName) {
  if (name === 'pending') return undefined;
  const state = notificationMonitorState();
  state.agentId = statusFixtureAgent;
  state.lastSuccessfulPollAt = 2;
  const active = approvedNotificationItem();
  active.repositoryOwner = 'MixedCaseOwner';
  active.repositoryName = 'Long-Notification-Repository-With-MixedCase';
  active.intake = {
    ...active.intake!,
    scheduling: { sequence: 1, status: 'active' },
    stage: 'prepared',
    worktreeBranch: 'PrivateBranch-MixedCase',
    worktreePath: '/Private/Worktree-MixedCase',
  };
  const queued = approvedNotificationItem();
  queued.number = 14;
  const pullRequest = approvedPullRequestNotificationItem();
  state.items = { active, queued, pullRequest };
  if (name === 'empty') state.items = {};
  if (name === 'degraded' || name === 'filtered') {
    active.intake.failureCode = 'github-notification-intake-failed';
    active.intake.scheduling = {
      sequence: 1,
      status: 'waiting',
      reasonCode: 'github-notification-WaitReason-MixedCase',
    };
    state.itemFailures = [
      {
        repository: 'OtherOwner/Long-Repository-Without-Write-Access',
        itemType: 'issue',
        number: 271,
        stage: 'permission-check',
        cause: 'repository-permission-denied',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        repository: 'OtherOwner/Second-Repository-Without-Write-Access',
        itemType: 'pull-request',
        number: 272,
        stage: 'permission-check',
        cause: 'repository-permission-denied',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ];
  }
  if (name === 'cleanup') {
    active.disposition = 'retired';
    active.intake.stage = 'retired';
    active.intake.cleanup = {
      status: 'skipped',
      session: 'archived',
      worktree: 'dirty',
      reasonCode: 'github-notification-cleanup-worktree-dirty',
    };
    queued.disposition = 'retired';
    queued.intake!.stage = 'retired';
    queued.intake!.cleanup = {
      status: 'failed',
      session: 'failed',
      worktree: 'failed',
      reasonCode: 'github-notification-cleanup-failed',
    };
    pullRequest.disposition = 'retired';
    pullRequest.intake!.stage = 'retired';
    pullRequest.intake!.cleanup = {
      status: 'completed',
      session: 'missing',
      worktree: 'not-applicable',
      reasonCode: 'github-notification-cleanup-completed',
    };
  }
  return state;
}

export async function captureStatusFixture(
  name: StatusFixtureName,
  {
    json = false,
    columns = 120,
    color = false,
    selector = name === 'filtered' ? statusFixtureSelector : undefined,
    warnings = name === 'degraded',
    itemKind = selector?.itemType,
    manifestStatus = 'loaded',
  }: {
    json?: boolean;
    columns?: number;
    color?: boolean;
    selector?: GitHubNotificationItemSelector;
    warnings?: boolean;
    itemKind?: string;
    manifestStatus?: 'loaded' | 'unmanaged';
  } = {},
) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const calls: unknown[][] = [];
  let exitCode = 0;
  const service = new GitHubNotificationStatusService({
    monitorService: {
      async runOnce() {
        throw new Error('status must never refresh');
      },
    },
    stateStore: {
      async read() {
        return statusFixtureState(name);
      },
    },
  });
  const manifest: AgentManifestLoadResult =
    manifestStatus === 'loaded'
      ? {
          status: 'loaded',
          scope: { workspaceDir: '/Fixture/Workspace' },
          path: '/Fixture/Workspace/agent.yaml',
          digest: 'fixture',
          manifest: { schemaVersion: 1, agent: { id: statusFixtureAgent } },
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
        }
      : { status: 'unmanaged', scope: { workspaceDir: '/Fixture/Workspace' }, diagnostics: [] };
  await statusNotificationsAgentSystem({
    json,
    styles: createCliStyles(color ? { FORCE_COLOR: '3' } : { NO_COLOR: '', FORCE_COLOR: '3' }),
    terminalColumns: columns,
    workspaceDir: '/Fixture/Workspace',
    repository: selector?.repository,
    itemKind,
    itemNumber: selector === undefined ? undefined : String(selector.number),
    manifestService: {
      async loadForAgentId() {
        throw new Error('fixture uses workspace discovery');
      },
      async loadForCommandDirectory() {
        return manifest;
      },
    },
    statusService: {
      async inspect(...args) {
        calls.push(args);
        return service.inspect(...args);
      },
    },
    output: {
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  return { events, calls, exitCode };
}
