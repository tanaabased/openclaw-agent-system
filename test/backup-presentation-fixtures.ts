import WorkspaceBackupService from '../agent/backup-service.ts';
import type {
  BackupCoverage,
  BackupPlan,
  CurrentWorkspaceBackupManifest,
} from '../agent/backup-types.ts';
import backupCreate from '../cli/backup-create.ts';
import { createCliStyles } from '../cli/output.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

// illustrative data only; real command rendering with no host operations.
export const backupPreviewPlan: BackupPlan = {
  agentId: 'Agent-Mixed',
  workspaceDir: '/Workspace/Mixed',
  settings: {
    output: '/Archives/Backup',
    gitIgnore: true,
    openclawState: 'auto',
    include: ['MEMORY.md', 'Memory/**', 'Missing-*.md'],
    exclude: ['Scratch/**'],
  },
  files: ['MEMORY.md', 'Memory/Day.md'],
  coverage: {
    stage: 'workspace-only',
    openclawState: 'pending',
    atomic: false,
    omittedPaths: [],
    limitations: [],
  },
  protectedPaths: [],
  diagnostics: [
    {
      code: 'backup-include-unmatched',
      message: 'An include pattern matched no workspace entries.',
      path: 'Missing-*.md',
    },
  ],
  selection: [
    { reason: 'exclude', observedEntries: 1, prunedDirectories: 1, directories: ['Scratch'] },
    { reason: 'protected', observedEntries: 1, prunedDirectories: 1, directories: [] },
  ],
};

export async function captureBackupCommand(
  options: {
    columns?: number;
    environment?: NodeJS.ProcessEnv;
    json?: boolean;
    dryRun?: boolean;
    state?: BackupCoverage['openclawState'];
    empty?: boolean;
    fail?: boolean;
  } = {},
) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const plan = {
    ...backupPreviewPlan,
    files: options.empty ? [] : backupPreviewPlan.files,
    coverage: { ...backupPreviewPlan.coverage, openclawState: options.state ?? 'pending' },
  };
  const manifest: CurrentWorkspaceBackupManifest = {
    format: 'agent-system-backup',
    version: 2,
    agentId: plan.agentId,
    capturedAt: '2026-10-01T00:00:00.000Z',
    settings: plan.settings,
    coverage: {
      ...plan.coverage,
      openclawState:
        options.state === 'captured' ? 'captured' : options.state === 'off' ? 'off' : 'absent',
    },
    inventory: [...plan.files, ...(!options.empty ? ['Later.md'] : [])].map((path) => ({
      path,
      type: 'file',
      mode: 0o600,
      size: 1,
    })),
    diagnostics: plan.diagnostics,
  };
  const service = new WorkspaceBackupService();
  service.plan = async () => plan;
  service.create = async () => {
    if (options.fail) throw new Error('External-Mixed failure');
    return {
      archive: '/Archives/Backup/Agent-Mixed.tar.gz',
      manifest,
      selection: [
        { reason: 'exclude', observedEntries: 1, prunedDirectories: 1, directories: ['Refreshed'] },
      ],
    };
  };
  const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
    status: 'loaded',
    manifest: { schemaVersion: 1, agent: { id: plan.agentId } },
    scope: { workspaceDir: plan.workspaceDir },
    path: '/Workspace/Mixed/agent.yaml',
    digest: 'fixture',
    diagnostics: [],
    validationChecks: [],
  };
  let exitCode = 0;
  await backupCreate({
    service,
    manifestService: {
      async loadForAgentId() {
        return loaded;
      },
      async loadForCommandDirectory() {
        return loaded;
      },
    },
    workspaceDir: plan.workspaceDir,
    environment: {},
    overrides: {},
    dryRun: options.dryRun ?? true,
    json: options.json ?? false,
    terminalColumns: options.columns ?? 100,
    styles: createCliStyles(options.environment ?? { NO_COLOR: '1' }),
    output: {
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  return { events, exitCode };
}
