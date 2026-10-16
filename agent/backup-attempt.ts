import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

import { assertPrivateStateLocksHeld } from '../core/private-state-lock-context.ts';

export interface BackupArtifactIdentity {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  birthtimeMs: number;
}

export function backupArtifactIdentity(stats: BackupArtifactIdentity): BackupArtifactIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    birthtimeMs: stats.birthtimeMs,
  };
}

export interface BackupAttempt {
  version: 1;
  id: string;
  agentId: string;
  workspaceDir: string;
  output: string;
  pid: number;
  snapshotWriter: boolean;
  artifacts: { path: string; identity: BackupArtifactIdentity; archive: boolean }[];
}

/** record only artifacts created by this capture, under its existing exclusive lease. */
export default class BackupAttemptWriter {
  readonly record: BackupAttempt;
  readonly path: string;
  private initialized = false;

  constructor(control: string, scope: Pick<BackupAttempt, 'agentId' | 'workspaceDir' | 'output'>) {
    this.record = {
      version: 1,
      id: randomUUID(),
      ...scope,
      pid: process.pid,
      snapshotWriter: false,
      artifacts: [],
    };
    this.path = join(control, `attempt-${this.record.id}.jsonl`);
  }

  private async append(value: unknown): Promise<void> {
    assertPrivateStateLocksHeld();
    const handle = await open(
      this.path,
      constants.O_WRONLY |
        constants.O_NOFOLLOW |
        (this.initialized ? constants.O_APPEND : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
      assertPrivateStateLocksHeld();
      this.initialized = true;
    } finally {
      await handle.close();
    }
  }

  async save(): Promise<void> {
    await this.append(
      this.initialized ? { snapshotWriter: this.record.snapshotWriter } : this.record,
    );
  }

  async add(path: string, archive = false): Promise<void> {
    if (!this.initialized) await this.save();
    const artifact = { path, identity: backupArtifactIdentity(await lstat(path)), archive };
    this.record.artifacts.push(artifact);
    await this.append({ artifact });
  }
}
