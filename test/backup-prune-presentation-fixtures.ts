import WorkspaceBackupService, {
  BackupPruneError,
  type BackupPruneResult,
} from '../agent/backup-service.ts';
import type { BackupPlan } from '../agent/backup-types.ts';
import backupPrune from '../cli/backup-prune.ts';
import { createCliStyles, type CliNotice, writeCliDiagnosticNotices } from '../cli/output.ts';
import presentCliCommand from '../cli/presentation.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

// illustrative results only; previews never inspect or delete host archives.
export const pruneDestination = '/Backups/MixedCase';
export const retainedArchive = `${pruneDestination}/Newest.tar.gz`;
export const removedArchive = `${pruneDestination}/Middle.tar.gz`;
export const deferredArchive = `${pruneDestination}/Oldest.tar.gz`;
export const skippedArchives = [
  { path: `${pruneDestination}/Foreign.tar.gz`, reason: 'other-agent' },
  { path: `${pruneDestination}/Notes.txt`, reason: 'unrelated-file' },
  { path: `${pruneDestination}/.pending-Write.tar.gz`, reason: 'pending-write' },
  { path: `${pruneDestination}/Nested`, reason: 'not-regular-file' },
  { path: `${pruneDestination}/Corrupt.tar.gz`, reason: 'backup-manifest-invalid' },
  { path: `${pruneDestination}/Unreadable.tar.gz`, reason: 'unreadable' },
];

export const pruneFixture: BackupPruneResult = {
  agentId: 'MixedCaseAgent',
  output: pruneDestination,
  keep: 1,
  kept: [retainedArchive],
  deleted: [],
  wouldDelete: [removedArchive, deferredArchive],
  skipped: skippedArchives,
};

export const partialPruneFixture: BackupPruneResult = {
  ...pruneFixture,
  deleted: [removedArchive],
  wouldDelete: [deferredArchive],
};

export const pruneFailure = {
  code: 'backup-prune-delete-failed',
  message: `Pruning stopped at ${deferredArchive}: EACCES MixedCaseError.`,
};

export async function capturePrunePreview({
  result = pruneFixture,
  dryRun = true,
  failure = false,
  json = false,
  environment = { NO_COLOR: '1' },
  terminalColumns = 120,
  notices = [],
}: {
  result?: BackupPruneResult;
  dryRun?: boolean;
  failure?: boolean;
  json?: boolean;
  environment?: NodeJS.ProcessEnv;
  terminalColumns?: number;
  notices?: CliNotice[];
} = {}) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  let exitCode = 0;
  let pruneInput: Parameters<WorkspaceBackupService['prune']>[0] | undefined;
  const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
    status: 'loaded',
    manifest: { schemaVersion: 1, agent: { id: result.agentId } },
    scope: { workspaceDir: '/IllustrativeWorkspace' },
    path: '/IllustrativeWorkspace/agent.yaml',
    digest: 'fixture',
    diagnostics: [],
    validationChecks: [],
  };
  class FixtureService extends WorkspaceBackupService {
    override async plan(): Promise<BackupPlan> {
      return {
        agentId: result.agentId,
        workspaceDir: loaded.scope.workspaceDir,
        settings: {
          output: result.output,
          gitIgnore: true,
          openclawState: 'off',
          include: [],
          exclude: [],
        },
        coverage: {
          stage: 'workspace-only',
          openclawState: 'off',
          atomic: false,
          omittedPaths: [],
          limitations: [],
        },
        files: [],
        diagnostics: [],
        protectedPaths: [],
      };
    }
    override async prune(input: Parameters<WorkspaceBackupService['prune']>[0]) {
      pruneInput = input;
      if (failure) throw new BackupPruneError(pruneFailure.code, pruneFailure.message, result);
      return result;
    }
  }
  const options = {
    output: {
      writeStdout: (text: string) => events.push({ stream: 'stdout', text }),
      writeStderr: (text: string) => events.push({ stream: 'stderr', text }),
    },
    styles: createCliStyles(environment),
    terminalColumns,
    json,
  };
  const command = presentCliCommand(async (presented: typeof options) => {
    writeCliDiagnosticNotices(presented, notices);
    await backupPrune({
      ...presented,
      service: new FixtureService(),
      manifestService: {
        async loadForAgentId() {
          return loaded;
        },
        async loadForCommandDirectory() {
          return loaded;
        },
      },
      environment: {},
      workspaceDir: loaded.scope.workspaceDir,
      destination: result.output,
      keep: String(result.keep),
      dryRun,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
  });
  await command(options);
  return {
    events,
    exitCode,
    pruneInput,
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
