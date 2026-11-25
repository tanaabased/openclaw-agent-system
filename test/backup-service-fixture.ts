import WorkspaceBackupService from '../agent/backup/backup-service.ts';

type BackupDependencies = ConstructorParameters<typeof WorkspaceBackupService>;

export default function backupServiceFixture(
  storage: NonNullable<BackupDependencies[3]>,
  runtimeLocations?: BackupDependencies[0],
  snapshotCommand?: BackupDependencies[1],
  beforePruneDelete?: BackupDependencies[2],
) {
  return new WorkspaceBackupService(runtimeLocations, snapshotCommand, beforePruneDelete, storage);
}
