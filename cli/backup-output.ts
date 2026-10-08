import { BackupError, type BackupDiagnostic } from '../agent/backup-types.ts';
import {
  type CliOutput,
  type CliStyles,
  writeCliDiagnosticNotices,
  writeCliJson,
  writeCliSummary,
} from './output.ts';

export interface BackupCliOutput {
  json: boolean;
  output: CliOutput;
  styles?: CliStyles;
  terminalColumns?: number;
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
  writeCliDiagnosticNotices(options, [{ severity: 'error', message }]);
  options.setExitCode(1);
}

const humanBackupDiagnostics: Record<string, string> = {
  'backup-include-unmatched': 'include pattern matched no observed workspace entries',
  'backup-symlink-omitted': 'link outside the selected payload omitted',
};

export function writeBackupDiagnostics(
  options: BackupCliOutput,
  diagnostics: BackupDiagnostic[],
): void {
  writeCliDiagnosticNotices(
    options,
    diagnostics.map(({ code, message, path }) => ({
      severity: 'warning',
      message: `${code}: ${options.json ? message : (humanBackupDiagnostics[code] ?? message)}${path ? ` (${path})` : ''}`,
    })),
  );
}
