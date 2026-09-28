import { resolve } from 'node:path';

import type WorkspaceBackupService from '../agent/backup-service.ts';
import { BackupError } from '../agent/backup-types.ts';
import { resolveBackupCaller, type BackupCommandContext } from './backup-context.ts';
import {
  type BackupCliOutput,
  writeBackupDiagnostics,
  writeBackupFailure,
} from './backup-output.ts';
import { writeCliJson, writeCliSummary } from './output.ts';

/** restore is an operator-only inspection action and never selects a live agent. */
export default async function backupRestore(
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
      writeCliSummary(
        options.output,
        [
          { label: 'backup', style: 'status', value: 'restored to staging' },
          { label: 'agent', style: 'target', value: manifest.agentId },
          { label: 'target', style: 'target', value: result.target },
          { label: 'workspace', style: 'field', value: `${result.target}/workspace` },
          ...(result.database
            ? [{ label: 'database', style: 'field' as const, value: result.database }]
            : []),
          ...omitted.map((value) => ({ label: 'omitted', style: 'warning' as const, value })),
        ],
        options.styles,
      );
    writeBackupDiagnostics(options, manifest.diagnostics);
  } catch (error) {
    writeBackupFailure(options, error);
  }
}
