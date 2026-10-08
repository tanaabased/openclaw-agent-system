import type { BackupCoverage, BackupPlan, BackupSettings } from '../agent/backup-types.ts';
import type { BackupCliOutput } from './backup-output.ts';
import { createCliStyles, type CliSummaryLine, writeCliLines, writeCliSummary } from './output.ts';

export default function writeBackupSelection(
  options: BackupCliOutput,
  result: {
    status: 'preview' | 'created and verified';
    agentId: string;
    workspaceDir: string;
    archive?: string;
    settings: BackupSettings;
    coverage: BackupCoverage;
    files: string[];
    selection: BackupPlan['selection'];
  },
): void {
  const styles = options.styles ?? createCliStyles();
  const state = {
    pending: 'agent database pending capture (not yet included)',
    captured: 'agent database captured',
    absent: 'agent database absent at capture',
    off: 'agent database off (not included)',
  }[result.coverage.openclawState];
  const lines: CliSummaryLine[] = [
    { label: 'backup', style: result.archive ? 'status' : 'action', value: result.status },
    { label: 'agent', style: 'target', value: result.agentId },
    { label: 'output', style: 'target', value: result.settings.output },
    ...(result.archive
      ? [{ label: 'archive', style: 'target' as const, value: result.archive }]
      : []),
    { label: 'entries', style: 'field', value: String(result.files.length) },
    { label: 'coverage', style: 'field', value: `workspace selected; ${state}` },
    {
      label: 'scope',
      style: 'field',
      value: 'non-atomic; external sources and memory backends not included',
    },
    {
      label: 'gitignore',
      style: 'field',
      value: result.settings.gitIgnore ? 'on; includes override ignores' : 'off',
    },
    {
      label: 'include',
      style: 'field',
      value: result.settings.include.length
        ? result.settings.include.join(', ')
        : 'none (default selection)',
    },
    {
      label: 'exclude',
      style: 'field',
      value: result.settings.exclude.length ? result.settings.exclude.join(', ') : 'none',
    },
    ...result.files.map((path): CliSummaryLine => ({
      label: 'selected',
      style: 'action',
      valueStyle: 'action',
      value: path,
    })),
    ...(result.selection ?? []).flatMap(
      ({ reason, observedEntries, prunedDirectories, directories }): CliSummaryLine[] => [
        {
          label: 'excluded',
          style: 'field',
          valueStyle: 'field',
          value: `${reason}: ${observedEntries} observed filter decisions; ${prunedDirectories} directories pruned`,
        },
        ...directories.map((path): CliSummaryLine => ({
          label: 'pruned',
          style: 'field',
          valueStyle: 'field',
          value: `${reason}: ${path}`,
        })),
        ...(prunedDirectories > directories.length && reason !== 'protected'
          ? [
              {
                label: 'pruned',
                style: 'field' as const,
                valueStyle: 'field' as const,
                value: `${reason}: ${prunedDirectories - directories.length} other directory boundaries (not sampled)`,
              },
            ]
          : []),
      ],
    ),
  ];
  writeCliLines(options.output, ['']);
  writeCliSummary(options.output, lines, styles, {
    rowPadding: 0,
    terminalColumns: options.terminalColumns ?? process.stdout.columns,
  });
  writeCliLines(options.output, ['', `workspace  ${styles.bold(result.workspaceDir)}`, '']);
}
