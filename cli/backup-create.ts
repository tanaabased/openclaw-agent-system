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
import { writeCliJson, writeCliSummary } from './output.ts';

/** create or preview one archive using the existing CLI output and trusted command binding. */
export default async function backupCreate(
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
        writeCliSummary(
          options.output,
          [
            { label: 'backup', style: 'action', value: 'preview' },
            { label: 'agent', style: 'target', value: plan.agentId },
            { label: 'output', style: 'target', value: plan.settings.output },
            { label: 'entries', style: 'field', value: String(plan.files.length) },
            {
              label: 'coverage',
              style: 'warning',
              value: 'workspace-only; OpenClaw state is not captured',
            },
            ...plan.files.map((path) => ({
              label: 'selected',
              style: 'field' as const,
              value: path,
            })),
          ],
          options.styles,
        );
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
      writeCliSummary(
        options.output,
        [
          { label: 'backup', style: 'status', value: 'created and verified' },
          { label: 'agent', style: 'target', value: result.manifest.agentId },
          { label: 'archive', style: 'target', value: result.archive },
          { label: 'entries', style: 'field', value: String(result.manifest.inventory.length) },
          {
            label: 'coverage',
            style: 'warning',
            value: 'workspace-only; OpenClaw state is not captured',
          },
        ],
        options.styles,
      );
    writeBackupDiagnostics(options, result.manifest.diagnostics);
  } catch (error) {
    writeBackupFailure(options, error);
  }
}
