import presentCliCommand from './presentation.ts';
import { resolve } from 'node:path';

import type WorkspaceBackupService from '../agent/backup-service.ts';
import {
  assertBackupArchiveLocation,
  assertBackupLocationOwner,
  loadBackupManifest,
  resolveBackupCaller,
  type BackupCommandContext,
} from './backup-context.ts';
import {
  type BackupCliOutput,
  writeBackupDiagnostics,
  writeBackupFailure,
} from './backup-output.ts';
import { writeCliJson, writeCliSummary } from './output.ts';

/** inspect an archive without extracting it or requiring an operator's live workspace. */
async function backupVerify(
  options: BackupCommandContext &
    BackupCliOutput & { service: WorkspaceBackupService; archive: string },
): Promise<void> {
  try {
    const binding = await resolveBackupCaller(options);
    let archive = resolve(options.workspaceDir, options.archive);
    if (binding) {
      const loaded = await loadBackupManifest(options, binding);
      archive = await assertBackupArchiveLocation(
        archive,
        loaded.scope.workspaceDir,
        loaded.manifest.backup?.output,
      );
    }
    if (binding) await assertBackupLocationOwner(options, binding, archive);
    const manifest = await options.service.verify(archive, binding?.agentId ?? options.agentId);
    if (options.json) writeCliJson(options.output, { status: 'verified', archive, ...manifest });
    else
      writeCliSummary(
        options.output,
        [
          { label: 'verification', style: 'status', value: 'verified' },
          { label: 'agent', style: 'target', value: manifest.agentId },
          { label: 'archive', style: 'target', value: archive },
          { label: 'entries', style: 'field', value: String(manifest.inventory.length) },
          {
            label: 'coverage',
            style: manifest.coverage.openclawState === 'captured' ? 'status' : 'field',
            value: `workspace and agent state: ${manifest.coverage.openclawState}`,
          },
        ],
        options.styles,
        { rowPadding: 0 },
      );
    writeBackupDiagnostics(options, manifest.diagnostics);
  } catch (error) {
    writeBackupFailure(options, error, 'verification');
  }
}

export default presentCliCommand(backupVerify);
