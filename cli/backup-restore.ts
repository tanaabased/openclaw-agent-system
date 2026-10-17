import { resolve } from 'node:path';

import type WorkspaceBackupService from '../agent/backup-service.ts';
import { BackupError, type WorkspaceBackupManifest } from '../agent/backup-types.ts';
import { resolveBackupCaller, type BackupCommandContext } from './backup-context.ts';
import {
  type BackupCliOutput,
  writeBackupDiagnostics,
  writeBackupFailure,
} from './backup-output.ts';
import { type CliSummaryLine, renderCliSummary, writeCliJson, writeCliLines } from './output.ts';
import presentCliCommand from './presentation.ts';

function restoreCoverageLines({
  coverage,
  diagnostics,
}: WorkspaceBackupManifest): CliSummaryLine[] {
  const quiet = (label: string, value: string): CliSummaryLine => ({
    label,
    value,
    style: 'field',
    quiet: true,
  });
  const warning = (label: string, value: string): CliSummaryLine => ({
    label,
    value,
    style: 'warning',
  });
  const state = coverage.openclawState;
  const database =
    state === 'off'
      ? [quiet('database disabled', 'agent database explicitly excluded at capture time')]
      : state === 'absent'
        ? [warning('database absent', 'optional agent database did not exist at capture time')]
        : state === 'unsupported'
          ? [warning('database unsupported', 'legacy archive does not contain an agent database')]
          : [];
  const limitations = coverage.limitations.flatMap((value): CliSummaryLine[] => {
    // recorded diagnostics own their explanations in the trailing messages section.
    if (diagnostics.some(({ message }) => message === value)) return [];
    // match recorded vocabulary exactly; unknown archive limitations retain warning severity.
    if (
      (state === 'off' && value === 'The OpenClaw agent database was explicitly omitted.') ||
      (state === 'absent' &&
        value === 'The selected OpenClaw agent database did not exist at capture time.')
    )
      return [];
    if (value === 'Out-of-workspace sources and external memory backends are not captured.')
      return [
        quiet('capture scope', 'out-of-workspace sources and external memory backends excluded'),
      ];
    if (
      state === 'captured' &&
      value === 'OpenClaw omits transient agent database lease rows from its snapshot.'
    )
      return [quiet('transient rows', 'agent database lease rows excluded from snapshot')];
    if (value === 'Files can change during capture; this is not an atomic workspace snapshot.')
      return [
        warning(
          'non-atomic capture',
          'files could change during capture; workspace snapshot is not atomic',
        ),
      ];
    return [warning('limitation', value)];
  });
  return [
    ...coverage.omittedPaths.map((path) => quiet('protected path', path)),
    ...database,
    ...limitations,
  ];
}

/** restore is an operator-only inspection action and never selects a live agent. */
async function backupRestore(
  options: BackupCommandContext &
    BackupCliOutput & { service: WorkspaceBackupService; archive: string; target: string },
): Promise<void> {
  try {
    if (!options.target)
      throw new BackupError('backup-target-required', 'Supply --target <fresh-directory>.');
    if (await resolveBackupCaller(options))
      throw new BackupError(
        'backup-restore-operator-only',
        'Backup restore is available only to an operator outside an agent or setup command.',
      );
    const archive = resolve(options.workspaceDir, options.archive);
    const result = await options.service.restore(
      archive,
      resolve(options.workspaceDir, options.target),
      options.agentId,
    );
    const { manifest } = result;
    const omitted = [
      ...manifest.coverage.omittedPaths,
      ...manifest.coverage.limitations,
      ...(manifest.coverage.openclawState === 'captured'
        ? []
        : [`OpenClaw agent database: ${manifest.coverage.openclawState}.`]),
    ];
    if (options.json)
      writeCliJson(options.output, {
        status: 'restored',
        archive,
        target: result.target,
        agentId: manifest.agentId,
        workspace: `${result.target}/workspace`,
        ...(result.database ? { database: result.database } : {}),
        coverage: manifest.coverage,
        omitted,
      });
    else
      writeCliLines(options.output, [
        '',
        ...renderCliSummary(
          [
            { label: 'backup', style: 'status', value: 'staged' },
            { label: 'archive', style: 'target', value: archive },
            { label: 'agent', style: 'target', value: manifest.agentId },
            { label: 'target', style: 'target', value: result.target },
            { label: 'workspace', style: 'target', value: `${result.target}/workspace` },
            ...(result.database
              ? [{ label: 'database', style: 'target' as const, value: result.database }]
              : []),
            {
              label: 'activation',
              style: 'field',
              quiet: true,
              value: 'not activated; staging only',
            },
            ...restoreCoverageLines(manifest),
          ],
          options.styles,
          { rowPadding: 0, terminalColumns: options.terminalColumns ?? process.stdout.columns },
        ),
        '',
      ]);
    writeBackupDiagnostics(options, manifest.diagnostics);
  } catch (error) {
    const humanMessage =
      error instanceof BackupError
        ? {
            'backup-target-required': 'supply --target <fresh-directory>.',
            'backup-restore-operator-only':
              'backup restore is available only to an operator outside an agent or setup command.',
          }[error.code]
        : undefined;
    writeBackupFailure(options, error, humanMessage);
  }
}

export default presentCliCommand(backupRestore);
