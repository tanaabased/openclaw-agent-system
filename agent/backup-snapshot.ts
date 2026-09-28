import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import nodeErrorCode from '../utils/node-error-code.ts';
import { BackupError, type BackupPlan, type OpenClawSnapshotManifest } from './backup-types.ts';

export interface BackupSnapshotCommand {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

function snapshotManifest(value: unknown, agentId: string): OpenClawSnapshotManifest {
  if (!value || typeof value !== 'object')
    throw new BackupError('backup-snapshot-invalid', 'OpenClaw returned no snapshot manifest.');
  const manifest = value as OpenClawSnapshotManifest;
  if (
    manifest.schemaVersion !== 1 ||
    !/^[a-zA-Z0-9-]+$/u.test(manifest.snapshotId) ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    manifest.database?.role !== 'agent' ||
    manifest.database.agentId !== agentId ||
    manifest.database.basename !== 'openclaw-agent.sqlite' ||
    !Number.isSafeInteger(manifest.database.userVersion) ||
    manifest.artifact?.path !== 'database.sqlite' ||
    !/^[a-f0-9]{64}$/u.test(manifest.artifact.sha256) ||
    !Number.isSafeInteger(manifest.artifact.sizeBytes) ||
    manifest.artifact.sizeBytes < 1
  )
    throw new BackupError(
      'backup-snapshot-invalid',
      'OpenClaw returned an invalid or differently owned agent snapshot.',
    );
  return manifest;
}

async function runSnapshotCommand(
  command: BackupSnapshotCommand | undefined,
  args: string[],
  cwd: string,
): Promise<{ snapshotPath: string; manifest: unknown }> {
  if (!command)
    throw new BackupError(
      'backup-snapshot-unavailable',
      'The OpenClaw SQLite snapshot command is unavailable in this runtime.',
    );
  let result: Awaited<ReturnType<BackupSnapshotCommand>>;
  try {
    result = await command(args, cwd);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT')
      throw new BackupError(
        'backup-snapshot-unavailable',
        'The installed OpenClaw CLI is unavailable for SQLite snapshots.',
      );
    throw new BackupError('backup-snapshot-failed', 'OpenClaw SQLite snapshot execution failed.');
  }
  if (result.code !== 0)
    throw new BackupError(
      'backup-snapshot-failed',
      `OpenClaw SQLite snapshot command failed: ${result.stderr.trim().slice(0, 1000) || `exit ${result.code}`}.`,
    );
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { ok?: unknown }).ok !== true ||
      typeof (parsed as { snapshotPath?: unknown }).snapshotPath !== 'string'
    )
      throw new Error('unexpected output');
    return parsed as { snapshotPath: string; manifest: unknown };
  } catch {
    throw new BackupError(
      'backup-snapshot-unavailable',
      'OpenClaw did not return the supported SQLite snapshot JSON result.',
    );
  }
}

export async function verifyAgentSnapshot(
  directory: string,
  expected: OpenClawSnapshotManifest,
  command: BackupSnapshotCommand | undefined,
): Promise<void> {
  const result = await runSnapshotCommand(
    command,
    ['backup', 'sqlite', 'verify', directory, '--json'],
    dirname(directory),
  );
  if (resolve(result.snapshotPath) !== resolve(directory))
    throw new BackupError('backup-snapshot-invalid', 'OpenClaw verified another snapshot path.');
  const verified = snapshotManifest(result.manifest, expected.database.agentId);
  try {
    assert.deepEqual(verified, expected);
  } catch {
    throw new BackupError(
      'backup-snapshot-invalid',
      'The embedded OpenClaw snapshot differs from its recorded metadata.',
    );
  }
}

/** let OpenClaw revalidate and materialize its own database into a fresh path. */
export async function restoreAgentSnapshot(
  directory: string,
  target: string,
  expected: OpenClawSnapshotManifest,
  command: BackupSnapshotCommand | undefined,
): Promise<void> {
  if (!command)
    throw new BackupError(
      'backup-snapshot-unavailable',
      'The OpenClaw SQLite restore command is unavailable in this runtime.',
    );
  let result: Awaited<ReturnType<BackupSnapshotCommand>>;
  try {
    result = await command(
      ['backup', 'sqlite', 'restore', directory, '--target', target, '--json'],
      dirname(directory),
    );
  } catch {
    throw new BackupError(
      'backup-snapshot-restore-failed',
      'OpenClaw SQLite restore execution failed.',
    );
  }
  if (result.code !== 0)
    throw new BackupError(
      'backup-snapshot-restore-failed',
      `OpenClaw SQLite restore failed: ${result.stderr.trim().slice(0, 1000) || `exit ${result.code}`}.`,
    );
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new BackupError(
      'backup-snapshot-restore-failed',
      'OpenClaw returned invalid restore JSON.',
    );
  }
  if (
    !response ||
    typeof response !== 'object' ||
    (response as { ok?: unknown }).ok !== true ||
    resolve((response as { targetPath?: string }).targetPath ?? '') !== resolve(target)
  )
    throw new BackupError(
      'backup-snapshot-restore-failed',
      'OpenClaw did not confirm SQLite restore.',
    );
  try {
    assert.deepEqual(
      snapshotManifest((response as { manifest?: unknown }).manifest, expected.database.agentId),
      expected,
    );
  } catch {
    throw new BackupError(
      'backup-snapshot-restore-failed',
      'OpenClaw restored a different snapshot.',
    );
  }
  const stats = await lstat(target).catch(() => {
    throw new BackupError(
      'backup-snapshot-restore-failed',
      'OpenClaw did not create a database file.',
    );
  });
  if (!stats.isFile())
    throw new BackupError(
      'backup-snapshot-restore-failed',
      'OpenClaw did not create a database file.',
    );
}

export async function captureAgentSnapshot(
  plan: BackupPlan,
  stage: string,
  command: BackupSnapshotCommand | undefined,
): Promise<{
  directory?: string;
  manifest?: OpenClawSnapshotManifest;
  state: 'captured' | 'absent' | 'off';
}> {
  if (plan.settings.openclawState === 'off') return { state: 'off' };
  if (!plan.agentDir)
    throw new BackupError(
      'backup-snapshot-unavailable',
      'The selected agent database location could not be resolved from OpenClaw.',
    );
  const database = join(plan.agentDir, 'openclaw-agent.sqlite');
  try {
    await lstat(database);
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
    if (plan.settings.openclawState === 'required')
      throw new BackupError('backup-snapshot-absent', 'The selected agent database is absent.');
    return { state: 'absent' };
  }
  const repository = join(stage, 'openclaw-repository');
  const result = await runSnapshotCommand(
    command,
    ['backup', 'sqlite', 'create', '--agent', plan.agentId, '--repository', repository, '--json'],
    plan.workspaceDir,
  );
  const manifest = snapshotManifest(result.manifest, plan.agentId);
  const directory = resolve(result.snapshotPath);
  if (dirname(directory) !== repository || basename(directory) !== manifest.snapshotId)
    throw new BackupError(
      'backup-snapshot-invalid',
      'OpenClaw returned a snapshot outside the private repository.',
    );
  const entries = (await readdir(directory)).sort();
  if (entries.length !== 2 || entries[0] !== 'database.sqlite' || entries[1] !== 'manifest.json')
    throw new BackupError(
      'backup-snapshot-invalid',
      'The OpenClaw snapshot contains unexpected files.',
    );
  let recorded: unknown;
  try {
    recorded = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  } catch {
    throw new BackupError(
      'backup-snapshot-invalid',
      'The OpenClaw snapshot manifest is unreadable.',
    );
  }
  try {
    assert.deepEqual(snapshotManifest(recorded, plan.agentId), manifest);
  } catch {
    throw new BackupError(
      'backup-snapshot-invalid',
      'The OpenClaw snapshot files differ from the command result.',
    );
  }
  const stats = await lstat(join(directory, 'database.sqlite'));
  if (!stats.isFile() || stats.size !== manifest.artifact.sizeBytes)
    throw new BackupError('backup-snapshot-invalid', 'The OpenClaw snapshot size changed.');
  await verifyAgentSnapshot(directory, manifest, command);
  return { directory, manifest, state: 'captured' };
}
