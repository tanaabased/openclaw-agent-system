import statusNotificationsAgentSystem from '../channels/github/cli/status.ts';
import type {
  GitHubNotificationStatusResult,
  GitHubNotificationItemSelector,
} from '../channels/github/cli/contracts.ts';
import { createCliStyles } from '../cli/output.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
// illustrative data only; command and projection run against injected services.
export const statusFixtureAgent = 'Agent-MixedCase';
export const statusFixtureRepository = 'MixedCaseOwner/Long-Notification-Repository-With-MixedCase';
export const statusFixtureNames = ['empty', 'healthy', 'pending', 'degraded', 'filtered'] as const;
export type StatusFixtureName = (typeof statusFixtureNames)[number];
export const statusFixtureSelector: GitHubNotificationItemSelector = {
  repository: statusFixtureRepository,
  itemType: 'issue',
  number: 12,
};

export function statusFixtureResult(
  name: StatusFixtureName,
  selector?: GitHubNotificationItemSelector,
): GitHubNotificationStatusResult {
  const failed = name === 'degraded' || name === 'filtered';
  const items: GitHubNotificationStatusResult['items'] =
    name === 'empty' || name === 'pending'
      ? []
      : [
          {
            disposition: 'approved',
            itemType: 'issue',
            lifecycleId: 'issue',
            number: 12,
            reasonCode: 'assignment-approved',
            repository: statusFixtureRepository,
            scheduling: failed ? 'waiting' : 'active',
            stage: 'prepared',
            worktree: 'ready',
            ...(failed
              ? {
                  failureCode: 'github-notification-intake-failed',
                  waitingReason: 'github-notification-WaitReason-MixedCase',
                }
              : {}),
          },
          {
            disposition: 'approved',
            itemType: 'issue',
            lifecycleId: 'issue',
            number: 14,
            reasonCode: 'assignment-approved',
            repository: 'tanaabased/example',
            scheduling: 'queued',
            stage: 'admitted',
            worktree: 'pending',
          },
        ];
  return {
    agentId: statusFixtureAgent,
    baseline: { status: name === 'pending' ? 'pending' : 'ready' },
    capacity: {
      active: name === 'empty' || name === 'pending' || failed ? 0 : 1,
      queued: items.length ? 1 : 0,
      limit: 2,
    },
    code:
      name === 'degraded'
        ? 'github-notification-native-state-unavailable'
        : 'github-notification-status-ready',
    ...(name === 'degraded'
      ? { diagnosticCode: 'github-notification-native-state-unavailable' }
      : {}),
    items: items.filter(
      (item) =>
        !selector ||
        (item.repository.toLowerCase() === selector.repository.toLowerCase() &&
          item.number === selector.number),
    ),
    schemaVersion: 2,
    status: name === 'degraded' ? 'degraded' : name === 'pending' ? 'pending' : 'ready',
  };
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
    nativeService: {
      async inspect(manifest, _workspace, selector) {
        calls.push([manifest.agent.id, selector]);
        return statusFixtureResult(name, selector);
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
