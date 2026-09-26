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

export interface BackupEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  mode: number;
  size: number;
  sha256?: string;
  linkTarget?: string;
}

export interface BackupCoverage {
  stage: 'workspace-only';
  openclawState: 'unsupported';
  atomic: false;
  omittedPaths: string[];
  limitations: string[];
}

export interface BackupPlan {
  agentId: string;
  workspaceDir: string;
  settings: BackupSettings;
  coverage: BackupCoverage;
  files: string[];
  diagnostics: BackupDiagnostic[];
  protectedPaths: string[];
}

export interface WorkspaceBackupManifest {
  format: 'agent-system-backup';
  version: 1;
  agentId: string;
  capturedAt: string;
  settings: BackupSettings;
  coverage: BackupCoverage;
  inventory: BackupEntry[];
  diagnostics: BackupDiagnostic[];
}
