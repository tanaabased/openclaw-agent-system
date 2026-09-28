import { BackupError, type BackupDiagnostic } from '../agent/backup-types.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnostics,
  writeCliJson,
  writeCliSummary,
} from './output.ts';

export interface BackupCliOutput {
  json: boolean;
  output: CliOutput;
  styles?: CliStyles;
  setExitCode(code: number): void;
}

export function writeBackupFailure(options: BackupCliOutput, error: unknown): void {
  const code = error instanceof BackupError ? error.code : 'backup-failed';
  const message = error instanceof Error ? error.message : 'The workspace backup operation failed.';
  const diagnostics = [{ code, message }];
  if (options.json) writeCliJson(options.output, { status: 'failed', diagnostics });
  else
    writeCliSummary(
      options.output,
      [{ label: 'backup', style: 'error', value: `failed (${code})` }],
      options.styles,
    );
  writeCliDiagnostics(options.output, [message]);
  options.setExitCode(1);
}

export function writeBackupDiagnostics(
  options: BackupCliOutput,
  diagnostics: BackupDiagnostic[],
): void {
  writeCliDiagnostics(
    options.output,
    diagnostics.map(({ code, message, path }) => `${code}: ${message}${path ? ` (${path})` : ''}`),
  );
}
