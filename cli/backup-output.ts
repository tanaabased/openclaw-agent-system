import { BackupError, type BackupDiagnostic } from '../agent/backup-types.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnosticNotices,
  writeCliJson,
  renderCliSummary,
  writeCliLines,
} from './output.ts';

export interface BackupCliOutput {
  json: boolean;
  output: CliOutput;
  styles?: CliStyles;
  terminalColumns?: number;
  setExitCode(code: number): void;
}

export function writeBackupFailure(
  options: BackupCliOutput,
  error: unknown,
  humanMessage?: string,
  label = 'backup',
): void {
  const code = error instanceof BackupError ? error.code : 'backup-failed';
  const message = error instanceof Error ? error.message : 'The workspace backup operation failed.';
  const diagnostics = [{ code, message }];
  if (options.json) writeCliJson(options.output, { status: 'failed', diagnostics });
  else
    writeCliLines(options.output, [
      '',
      ...renderCliSummary([{ label, style: 'error', value: `failed (${code})` }], options.styles, {
        rowPadding: 0,
        terminalColumns: options.terminalColumns ?? process.stdout.columns,
      }),
      '',
    ]);
  writeCliDiagnosticNotices(options, [
    { severity: 'error', message: options.json ? message : (humanMessage ?? message) },
  ]);
  options.setExitCode(1);
}

export function writeBackupDiagnostics(
  options: BackupCliOutput,
  diagnostics: BackupDiagnostic[],
): void {
  writeCliDiagnosticNotices(
    options,
    diagnostics.map(({ code, message, path }) => ({
      severity: 'warning',
      message: `${code}: ${message}${path ? ` (${path})` : ''}`,
    })),
  );
}
