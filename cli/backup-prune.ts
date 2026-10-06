import presentCliCommand from './presentation.ts';
import {
  BackupPruneError,
  type BackupPruneResult,
  type default as WorkspaceBackupService,
} from '../agent/backup-service.ts';
import { BackupError } from '../agent/backup-types.ts';
import {
  assertBackupLocationOwner,
  loadBackupManifest,
  resolveBackupCaller,
  type BackupCommandContext,
} from './backup-context.ts';
import { type BackupCliOutput, writeBackupFailure } from './backup-output.ts';
import { writeCliError, writeCliJson, writeCliSummary } from './output.ts';

/** prune selected local archives after checking caller authority and destination ownership. */
async function backupPrune(
  options: BackupCommandContext &
    BackupCliOutput & {
      service: WorkspaceBackupService;
      keep: string | undefined;
      dryRun: boolean;
      destination?: string;
    },
): Promise<void> {
  let result: BackupPruneResult | undefined;
  try {
    if (
      !options.keep ||
      !/^[1-9]\d*$/u.test(options.keep) ||
      !Number.isSafeInteger(Number(options.keep))
    )
      throw new BackupError('backup-keep-invalid', 'Supply --keep as a positive integer.');
    const binding = await resolveBackupCaller(options);
    if (binding?.setupMode === 'check' && !options.dryRun)
      throw new BackupError(
        'backup-setup-check-read-only',
        'Setup checks may preview pruning with --dry-run; deletion requires an apply step.',
      );
    const loaded = await loadBackupManifest(options, binding);
    const plan = await options.service.plan({
      manifest: loaded.manifest,
      workspaceDir: loaded.scope.workspaceDir,
      overrides: options.destination ? { output: options.destination } : {},
      bound: Boolean(binding),
    });
    if (binding) await assertBackupLocationOwner(options, binding, plan.settings.output);
    result = await options.service.prune({
      manifest: loaded.manifest,
      workspaceDir: loaded.scope.workspaceDir,
      output: options.destination,
      keep: Number(options.keep),
      dryRun: options.dryRun,
      bound: Boolean(binding),
    });
    if (options.json)
      writeCliJson(options.output, { status: options.dryRun ? 'preview' : 'pruned', ...result });
    else
      writeCliSummary(
        options.output,
        [
          { label: 'backup', style: 'status', value: options.dryRun ? 'prune preview' : 'pruned' },
          { label: 'agent', style: 'target', value: result.agentId },
          { label: 'output', style: 'target', value: result.output },
          ...result.kept.map((path) => ({ label: 'kept', style: 'field' as const, value: path })),
          ...result.deleted.map((path) => ({
            label: 'deleted',
            style: 'field' as const,
            value: path,
          })),
          ...result.wouldDelete.map((path) => ({
            label: 'would-delete',
            style: 'field' as const,
            value: path,
          })),
          ...result.skipped.map(({ path, reason }) => ({
            label: 'skipped',
            style: 'warning' as const,
            value: `${path} (${reason})`,
          })),
        ],
        options.styles,
      );
  } catch (error) {
    if (error instanceof BackupPruneError) {
      result = error.result;
      if (options.json)
        writeCliJson(options.output, {
          status: 'failed',
          ...result,
          diagnostics: [{ code: error.code, message: error.message }],
        });
      else
        writeCliSummary(
          options.output,
          [
            { label: 'backup', style: 'error', value: `failed (${error.code})` },
            ...result.kept.map((path) => ({ label: 'kept', style: 'field' as const, value: path })),
            ...result.deleted.map((path) => ({
              label: 'deleted',
              style: 'field' as const,
              value: path,
            })),
            ...result.wouldDelete.map((path) => ({
              label: 'would-delete',
              style: 'field' as const,
              value: path,
            })),
            ...result.skipped.map(({ path, reason }) => ({
              label: 'skipped',
              style: 'warning' as const,
              value: `${path} (${reason})`,
            })),
          ],
          options.styles,
        );
      writeCliError(options.output, error.message, options);
      options.setExitCode(1);
    } else writeBackupFailure(options, error);
  }
}

export default presentCliCommand(backupPrune);
