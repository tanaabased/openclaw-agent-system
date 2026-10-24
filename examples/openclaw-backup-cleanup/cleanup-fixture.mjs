import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// runtime-derived identities and the now-exited fixture process model interrupted captures.
const workspaceDir = await realpath(process.cwd());
const output = join(workspaceDir, '.agent-system/backups');
const control = join(workspaceDir, '.agent-system/backup-staging');
for (const kind of ['incomplete', 'complete', 'foreign']) {
  const id = randomUUID();
  const stage = join(control, `capture-${id}`);
  await mkdir(stage, { mode: 0o700 });
  const archive = join(stage, 'archive.tar.gz');
  if (kind === 'complete') await copyFile(process.argv[2], archive);
  else await writeFile(archive, Buffer.from([0x1f, 0x8b, 0x08, 0]), { mode: 0o600 });
  const artifacts = [];
  for (const path of [stage, archive]) {
    const { dev, ino, mode, uid, birthtimeMs } = await lstat(path);
    artifacts.push({
      path,
      identity: { dev, ino, mode, uid, birthtimeMs },
      archive: path === archive,
    });
  }
  await writeFile(
    join(control, `attempt-${id}.jsonl`),
    `${JSON.stringify({
      version: 1,
      id,
      agentId: kind === 'foreign' ? 'other-agent' : 'backup-cleanup-tanaabot',
      workspaceDir,
      output,
      pid: process.pid,
      snapshotWriter: false,
      artifacts,
    })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
