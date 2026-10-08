import presentCliCommand from './presentation.ts';
import type WorkspaceBackupService from '../agent/backup-service.ts';
import { BackupError } from '../agent/backup-types.ts';
import type { BackupConfiguration } from '../manifest/backup-schema.ts';
import {
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
import { writeCliJson } from './output.ts';
import writeBackupSelection from './backup-selection-output.ts';

/** create or preview one archive using the existing CLI output and trusted command binding. */
async function backupCreate(
  options: BackupCommandContext &
    BackupCliOutput & {
      service: WorkspaceBackupService;
      overrides: BackupConfiguration;
      dryRun: boolean;
    },
): Promise<void> {
  try {
    const binding = await resolveBackupCaller(options);
    if (binding?.setupMode === 'check' && !options.dryRun)
      throw new BackupError(
        'backup-setup-check-read-only',
        'Setup checks may preview backups with --dry-run or verify an archive; creation requires an apply step.',
      );
    const loaded = await loadBackupManifest(options, binding);
    const plan = await options.service.plan({
      manifest: loaded.manifest,
      workspaceDir: loaded.scope.workspaceDir,
      overrides: options.overrides,
      bound: Boolean(binding),
    });
    if (binding) await assertBackupLocationOwner(options, binding, plan.settings.output);
    if (options.dryRun) {
      const { agentId, workspaceDir, settings, coverage, files, diagnostics } = plan;
      const result = { agentId, workspaceDir, settings, coverage, files, diagnostics };
      if (options.json) writeCliJson(options.output, { status: 'preview', ...result });
      else
        writeBackupSelection(options, {
          status: 'preview',
          agentId,
          workspaceDir,
          settings,
          coverage,
          files,
          selection: plan.selection,
        });
      writeBackupDiagnostics(options, plan.diagnostics);
      return;
    }
    const result = await options.service.create(plan);
    if (options.json)
      writeCliJson(options.output, {
        status: 'created',
        archive: result.archive,
        ...result.manifest,
      });
    else
      writeBackupSelection(options, {
        status: 'created and verified',
        agentId: result.manifest.agentId,
        workspaceDir: plan.workspaceDir,
        archive: result.archive,
        settings: result.manifest.settings,
        coverage: result.manifest.coverage,
        files: result.manifest.inventory.map(({ path }) => path),
        selection: result.selection,
      });
    writeBackupDiagnostics(options, result.manifest.diagnostics);
  } catch (error) {
    writeBackupFailure(options, error);
  }
}

export default presentCliCommand(backupCreate);
