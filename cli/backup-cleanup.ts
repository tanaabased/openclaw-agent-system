import { resolve } from 'node:path';

import type WorkspaceBackupService from '../agent/backup-service.ts';
import { BackupCleanupError, type BackupCleanupResult } from '../agent/backup-cleanup.ts';
import { BackupError, backupDefaultOutput } from '../agent/backup-types.ts';
import { canonicalBackupPath } from '../agent/backup-selection.ts';
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
  writeCliDiagnosticNotices,
  writeCliJson,
  writeCliSummary,
} from './output.ts';
import presentCliCommand from './presentation.ts';

function writeResult(
  options: BackupCliOutput & { apply: boolean },
  result: BackupCleanupResult,
  failed = false,
) {
  if (options.json) {
    writeCliJson(options.output, {
      status: failed ? 'failed' : options.apply ? 'applied' : 'preview',
      ...result,
    });
    return;
  }
  const styles = options.styles ?? createCliStyles();
  const group = (label: string, paths: string[], style: 'field' | 'action'): CliSummaryLine => ({
    label: `${label} (${paths.length})`,
    style,
    value: paths.length ? paths.join('\n') : styles.field('none'),
  });
  options.output.writeStdout('\n');
  writeCliSummary(
    options.output,
    [
      { label: 'backup', style: failed ? 'error' : 'action', value: 'cleanup' },
      { label: 'agent', style: 'target', value: result.agentId },
      { label: 'output', style: 'target', value: result.output },
      {
        label: 'mode',
        style: failed ? 'error' : 'action',
        value: failed ? 'apply stopped' : options.apply ? 'applied' : 'preview',
      },
      group('would-delete', result.wouldDelete, 'action'),
      group('deleted', result.deleted, 'action'),
      group(
        'preserved',
        result.preserved.map(({ path, reason }) => `${path} (${reason})`),
        'field',
      ),
    ],
    styles,
    { rowPadding: 0, terminalColumns: options.terminalColumns },
  );
  options.output.writeStdout(
    `\n${styles.field('workspace')}  ${styles.target(result.workspaceDir)}\n\n`,
  );
}

async function backupCleanup(
  options: BackupCommandContext &
    BackupCliOutput & {
      service: Pick<WorkspaceBackupService, 'cleanup'>;
      apply: boolean;
    },
): Promise<void> {
  try {
    const binding = await resolveBackupCaller(options);
    if (binding && options.apply)
      throw new BackupError(
        'backup-cleanup-operator-required',
        'backup cleanup apply is operator-only; bound callers may preview without --apply.',
      );
    const loaded = await loadBackupManifest(options, binding);
    // validate destination ownership for operators too, before reading attempt state.
    const output = await canonicalBackupPath(
      resolve(loaded.scope.workspaceDir, loaded.manifest.backup?.output ?? backupDefaultOutput),
    );
    await assertBackupLocationOwner(options, { agentId: loaded.manifest.agent.id }, output);
    const result = await options.service.cleanup({
      manifest: loaded.manifest,
      workspaceDir: loaded.scope.workspaceDir,
      apply: options.apply,
      expectedOutput: output,
    });
    writeResult(options, result);
  } catch (error) {
    if (error instanceof BackupCleanupError) {
      if (options.json)
        writeCliJson(options.output, {
          status: 'failed',
          ...error.result,
          diagnostics: [{ code: error.code, message: error.message }],
        });
      else writeResult(options, error.result, true);
      writeCliDiagnosticNotices(options, [
        { severity: 'error', message: `${error.code}: ${error.message}` },
      ]);
      options.setExitCode(1);
    } else writeBackupFailure(options, error);
  }
}

export default presentCliCommand(backupCleanup);
