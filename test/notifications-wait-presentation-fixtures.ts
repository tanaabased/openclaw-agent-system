import { createCliStyles } from '../cli/output.ts';
import waitNotificationsAgentSystem from '../channels/github/cli/wait.ts';
import type {
  GitHubNotificationWaitInput,
  GitHubNotificationWaitResult,
} from '../channels/github/intake/monitor/status-service.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

const manifest: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'fixture',
  manifest: { schemaVersion: 1, agent: { id: 'fixture-agent' } },
  diagnostics: [],
  validationChecks: [],
};

const observation = {
  agentId: 'fixture-agent',
  baseline: { status: 'ready' as const },
  capacity: { active: 1, limit: 2, queued: 0 },
  code: 'github-notification-status-ready',
  items: [
    {
      disposition: 'approved' as const,
      itemType: 'issue' as const,
      lifecycleId: 'issue' as const,
      number: 12,
      reasonCode: 'github-notification-item-prepared',
      repository: 'tanaabased/example',
      stage: 'prepared' as const,
      worktree: 'ready' as const,
    },
  ],
  schemaVersion: 2 as const,
  status: 'ready' as const,
};

type Preview = 'baseline-success' | 'item-success' | 'timeout' | 'degraded' | 'invalid-options';

export async function captureWaitPreview(
  preview: Preview,
  options: { columns?: number; color?: boolean; json?: boolean } = {},
) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  let waitInput: GitHubNotificationWaitInput | undefined;
  const result: GitHubNotificationWaitResult = {
    agentId: 'fixture-agent',
    code:
      preview === 'timeout'
        ? 'github-notification-wait-timeout'
        : preview === 'degraded'
          ? 'github-notification-status-degraded'
          : preview === 'item-success'
            ? 'github-notification-item-prepared'
            : 'github-notification-baseline-ready',
    observation:
      preview === 'degraded'
        ? { ...observation, code: 'github-notification-status-degraded', status: 'degraded' }
        : observation,
    schemaVersion: 2,
    status: preview === 'timeout' ? 'timed-out' : preview === 'degraded' ? 'failed' : 'completed',
    target: preview === 'item-success' ? 'prepared' : 'baseline-ready',
  };
  let exitCode = 0;
  await waitNotificationsAgentSystem({
    ...(preview === 'item-success'
      ? { itemKind: 'issue', itemNumber: '12', repository: 'tanaabased/example' }
      : {}),
    json: options.json ?? false,
    manifestService: {
      loadForAgentId: async () => manifest,
      loadForCommandDirectory: async () => manifest,
    },
    output: {
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
    },
    refresh: preview === 'item-success',
    setExitCode: (code) => {
      exitCode = code;
    },
    statusService: {
      wait: async (input) => {
        waitInput = input;
        return result;
      },
    },
    styles: createCliStyles(options.color ? { FORCE_COLOR: '3' } : { NO_COLOR: '1' }),
    target: preview === 'invalid-options' ? 'invalid' : result.target,
    timeoutSeconds: '12',
    workspaceDir: '/workspace',
  });
  return { events, exitCode, columns: options.columns ?? 100, waitInput };
}
