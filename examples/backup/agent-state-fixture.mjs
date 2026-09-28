import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { openOpenClawAgentDatabase } from 'openclaw/plugin-sdk/sqlite-runtime';

const [mode, path] = process.argv.slice(2);
if (!path || (mode !== 'seed' && mode !== 'verify'))
  throw new Error('Use seed <ready-file> or verify <snapshot-database>.');

if (mode === 'seed') {
  const opened = openOpenClawAgentDatabase({ agentId: 'backup-example' });
  const database = opened.db;
  database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  database.exec(
    'CREATE TABLE IF NOT EXISTS backup_fixture (id TEXT PRIMARY KEY, value BLOB NOT NULL);',
  );
  database.exec("INSERT OR REPLACE INTO backup_fixture VALUES ('reclaimable', zeroblob(1048576));");
  database.exec("DELETE FROM backup_fixture WHERE id = 'reclaimable';");
  database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  assert.ok(database.prepare('PRAGMA freelist_count').get().freelist_count > 0);
  database.exec(
    "INSERT OR REPLACE INTO backup_fixture VALUES ('durable', 'committed-wal-record');",
  );
  writeFileSync(path, `${opened.path}\n`, { mode: 0o600 });
  setInterval(() => {}, 1000);
} else {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      database.prepare("SELECT value FROM backup_fixture WHERE id = 'durable'").get().value,
      'committed-wal-record',
    );
    assert.equal(database.prepare('PRAGMA freelist_count').get().freelist_count, 0);
  } finally {
    database.close();
  }
}
