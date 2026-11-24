import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

async function main() {
  const [root, beforePath] = process.argv.slice(2) as [string, string];
  const before = JSON.parse(await readFile(beforePath, 'utf8'));
  assert.match(before.id, /^[a-f0-9]{64}$/u);
  const storage = join(process.env.OPENCLAW_STATE_DIR!, 'agent-system-storage');
  for (const name of await readdir(storage)) {
    if (!name.endsWith('.sqlite')) continue;
    const db = new DatabaseSync(join(storage, name), { readOnly: true });
    try {
      assert.equal(
        db.prepare('SELECT id FROM dispatch_records WHERE id = ?').get(before.id),
        undefined,
      );
    } finally {
      db.close();
    }
  }
  for (const name of await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (/^history-openclaw-[a-f0-9]{64}$/u.test(name)) {
      for (const file of await readdir(join(root, name))) {
        if (!/^\d+-[a-f0-9]{64}\.json$/u.test(file)) continue;
        const snapshot = JSON.parse(await readFile(join(root, name, file), 'utf8'));
        assert.notEqual(snapshot.value?.id, before.id);
      }
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
