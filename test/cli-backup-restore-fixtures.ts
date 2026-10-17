import WorkspaceBackupService from '../agent/backup-service.ts';
import { BackupError, type WorkspaceBackupManifest } from '../agent/backup-types.ts';
import backupRestore from '../cli/backup-restore.ts';
import { createCliStyles } from '../cli/output.ts';

// illustrative data only; the real cli runs against an injected restore boundary.
export const restoreFixturePaths = {
  archive: '/Backup/Archive-MixedCase.tar.gz',
  target: '/Recovery/Agent-MixedCase',
  workspace: '/Recovery/Agent-MixedCase/workspace',
  database: '/Recovery/Agent-MixedCase/openclaw-state/openclaw-agent.sqlite',
};

export const restoreFixtures = {
  captured: {
    state: 'captured',
    limitations: ['OpenClaw omits transient agent database lease rows from its snapshot.'],
  },
  absent: {
    state: 'absent',
    limitations: ['The selected OpenClaw agent database did not exist at capture time.'],
  },
  omissions: {
    state: 'off',
    limitations: ['The OpenClaw agent database was explicitly omitted.'],
  },
  degraded: {
    state: 'captured',
    limitations: [
      'External CaptureLimit: MemoryStore unavailable.',
      'CaptureError: unreadable entry.',
    ],
  },
  legacy: { state: 'unsupported', limitations: [] },
  rejected: { state: 'off', limitations: [] },
  failed: { state: 'off', limitations: [] },
} as const;

export type RestoreFixtureName = keyof typeof restoreFixtures;

export function restoreFixtureManifest(name: RestoreFixtureName): WorkspaceBackupManifest {
  const fixture = restoreFixtures[name];
  const common = {
    format: 'agent-system-backup' as const,
    agentId: 'Agent-MixedCase',
    capturedAt: '2026-09-01T00:00:00.000Z',
    inventory: [],
    diagnostics:
      name === 'degraded'
        ? [
            {
              code: 'backup-include-unmatched',
              message: 'No Match for Optional.md.',
              path: 'Optional.md',
            },
            { code: 'backup-capture-warning', message: 'CaptureError: unreadable entry.' },
          ]
        : [],
  };
  const coverage = {
    stage:
      fixture.state === 'captured'
        ? ('workspace-and-agent-state' as const)
        : ('workspace-only' as const),
    atomic: false as const,
    omittedPaths: ['/Protected/AgentKey'],
    limitations: [
      ...fixture.limitations,
      'Out-of-workspace sources and external memory backends are not captured.',
      'Files can change during capture; this is not an atomic workspace snapshot.',
    ],
  };
  const settings = { output: '/Backup', gitIgnore: true, include: [], exclude: [] };
  if (fixture.state === 'unsupported')
    return {
      ...common,
      version: 1,
      settings,
      coverage: { ...coverage, stage: 'workspace-only', openclawState: 'unsupported' },
    };
  return {
    ...common,
    version: 2,
    settings: { ...settings, openclawState: fixture.state === 'off' ? 'off' : 'auto' },
    coverage: { ...coverage, openclawState: fixture.state },
  };
}

export async function captureRestoreFixture(
  name: RestoreFixtureName,
  { json = false, columns = 120, color = false, target = restoreFixturePaths.target } = {},
) {
  const manifest = restoreFixtureManifest(name);
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const calls: unknown[][] = [];
  let exitCode = 0;
  class FixtureService extends WorkspaceBackupService {
    override async restore(...args: Parameters<WorkspaceBackupService['restore']>) {
      calls.push(args);
      if (name === 'failed')
        throw new BackupError('backup-target-nonempty', 'The restore target must be empty.');
      return {
        target: restoreFixturePaths.target,
        manifest,
        ...(manifest.coverage.openclawState === 'captured'
          ? { database: restoreFixturePaths.database }
          : {}),
      };
    }
  }
  await backupRestore({
    archive: restoreFixturePaths.archive,
    target,
    workspaceDir: '/Operator/Workspace',
    environment: {},
    manifestService: {
      async loadForAgentId() {
        throw new Error('restore must not load live agent metadata');
      },
      async loadForCommandDirectory() {
        throw new Error('restore must not load live agent metadata');
      },
    },
    ...(name === 'rejected'
      ? {
          commandAuthority: {
            async resolve() {
              return {
                agentId: 'Agent-MixedCase',
                workingDirectory: '/Operator/Workspace',
                admittedWorkingDirectories: ['/Operator/Workspace'],
              };
            },
          },
        }
      : { agentId: 'Agent-MixedCase' }),
    service: new FixtureService(),
    json,
    terminalColumns: columns,
    styles: createCliStyles(color ? { FORCE_COLOR: '3' } : { NO_COLOR: '', FORCE_COLOR: '3' }),
    output: {
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  return { calls, events, exitCode, manifest };
}
