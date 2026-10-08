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
import {
  createCliStyles,
  type CliSummaryLine,
  writeCliError,
  writeCliJson,
  writeCliSummary,
} from './output.ts';

function writePruneSummary(
  options: BackupCliOutput & { dryRun: boolean; terminalColumns?: number },
  result: BackupPruneResult,
  failureCode?: string,
): void {
  const styles = options.styles ?? createCliStyles();
  const group = (label: string, paths: string[], style: 'field' | 'action'): CliSummaryLine => ({
    label: `${label} (${paths.length})`,
    style,
    value: paths.length
      ? paths.map((path) => (style === 'field' ? styles.field(path) : path)).join('\n')
      : styles.field('none'),
  });
  const intentionalSkips = new Set([
    'not-regular-file',
    'pending-write',
    'unrelated-file',
    'other-agent',
  ]);
  options.output.writeStdout('\n');
  writeCliSummary(
    options.output,
    [
      {
        label: 'backup',
        style: failureCode ? 'error' : 'action',
        value: failureCode ? `prune failed (${failureCode})` : 'prune',
      },
      { label: 'agent', style: 'target', value: result.agentId },
      { label: 'output', style: 'target', value: result.output },
      { label: 'keep', style: 'field', value: String(result.keep) },
      {
        label: 'mode',
        style: options.dryRun || failureCode ? 'action' : 'status',
        value: options.dryRun ? 'preview' : failureCode ? 'apply stopped' : 'applied',
      },
      group('kept', result.kept, 'field'),
      group('would-delete', result.wouldDelete, 'action'),
      group('deleted', result.deleted, 'action'),
      {
        label: `skipped (${result.skipped.length})`,
        style: 'field',
        value: result.skipped.length
          ? result.skipped
              .map(({ path, reason }) =>
                intentionalSkips.has(reason)
                  ? styles.field(`${path} (${reason})`)
                  : `${path} (${styles.warning(reason)})`,
              )
              .join('\n')
          : styles.field('none'),
      },
    ],
    styles,
    { rowPadding: 0, terminalColumns: options.terminalColumns },
  );
  options.output.writeStdout('\n');
}

/** prune selected local archives after checking caller authority and destination ownership. */
async function backupPrune(
  options: BackupCommandContext &
    BackupCliOutput & {
      service: WorkspaceBackupService;
      keep: string | undefined;
      dryRun: boolean;
      destination?: string;
      terminalColumns?: number;
    },
): Promise<void> {
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
    const result = await options.service.prune({
      manifest: loaded.manifest,
      workspaceDir: loaded.scope.workspaceDir,
      output: options.destination,
      keep: Number(options.keep),
      dryRun: options.dryRun,
      bound: Boolean(binding),
    });
    if (options.json)
      writeCliJson(options.output, { status: options.dryRun ? 'preview' : 'pruned', ...result });
    else writePruneSummary(options, result);
  } catch (error) {
    if (error instanceof BackupPruneError) {
      const result = error.result;
      if (options.json)
        writeCliJson(options.output, {
          status: 'failed',
          ...result,
          diagnostics: [{ code: error.code, message: error.message }],
        });
      else writePruneSummary(options, result, error.code);
      writeCliError(options.output, error.message, options);
      options.setExitCode(1);
    } else writeBackupFailure(options, error);
  }
}

export default presentCliCommand(backupPrune);
