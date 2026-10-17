import type { BackupConfiguration } from '../manifest/backup-schema.ts';

export const backupDefaultOutput = '.agent-system/backups';
export const backupControlDirectory = '.agent-system/backup-staging';

export class BackupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BackupDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export type BackupSettings = Required<BackupConfiguration>;

export interface BackupRuntimeProtection {
  paths: string[];
  livePaths?: string[];
  agentDir?: string;
  openclawVersion?: string;
  stateDir?: string;
  workspaceDir?: string;
}

export interface BackupEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  mode: number;
  size: number;
  sha256?: string;
  linkTarget?: string;
}

export interface BackupCoverage {
  stage: 'workspace-only' | 'workspace-and-agent-state';
  openclawState: 'pending' | 'captured' | 'absent' | 'off';
  atomic: false;
  omittedPaths: string[];
  limitations: string[];
}

export interface BackupSelectionSummary {
  reason: 'protected' | 'exclude' | 'regenerable' | 'gitignore';
  observedEntries: number;
  prunedDirectories: number;
  directories: string[];
}

export interface BackupPlan {
  agentId: string;
  workspaceDir: string;
  settings: BackupSettings;
  coverage: BackupCoverage;
  files: string[];
  diagnostics: BackupDiagnostic[];
  protectedPaths: string[];
  selection?: BackupSelectionSummary[];
  agentDir?: string;
  openclawVersion?: string;
}

export interface OpenClawSnapshotManifest {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  database: {
    role: 'agent';
    agentId: string;
    basename: string;
    userVersion: number;
  };
  artifact: { path: 'database.sqlite'; sha256: string; sizeBytes: number };
}

interface BackupManifestBase {
  format: 'agent-system-backup';
  agentId: string;
  capturedAt: string;
  inventory: BackupEntry[];
  diagnostics: BackupDiagnostic[];
}

export interface LegacyWorkspaceBackupManifest extends BackupManifestBase {
  version: 1;
  settings: Omit<BackupSettings, 'openclawState'>;
  coverage: {
    stage: 'workspace-only';
    openclawState: 'unsupported';
    atomic: false;
    omittedPaths: string[];
    limitations: string[];
  };
}

export interface CurrentWorkspaceBackupManifest extends BackupManifestBase {
  version: 2;
  settings: BackupSettings;
  coverage: Omit<BackupCoverage, 'openclawState'> & {
    openclawState: 'captured' | 'absent' | 'off';
  };
  snapshot?: {
    manifest: OpenClawSnapshotManifest;
    openclawVersion: string;
    agentSystemVersion: string;
  };
}

export type WorkspaceBackupManifest =
  LegacyWorkspaceBackupManifest | CurrentWorkspaceBackupManifest;
