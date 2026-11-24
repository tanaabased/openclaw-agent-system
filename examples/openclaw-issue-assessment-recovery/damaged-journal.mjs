import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { agentDatabases } from '../../scripts/sqlite-example-state.mjs';

const [mode, ownerPath] = process.argv.slice(2);
const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
const damaged = JSON.parse(readFileSync(new URL('./damaged-tasks.json', import.meta.url), 'utf8'));
let owners = 0;
for (const path of agentDatabases()) {
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT scope FROM dispatch_records WHERE id = ?').get(owner.id);
    if (!row) continue;
    owners++;
    for (const record of damaged) {
      if (mode === 'seed') {
        db.prepare('INSERT INTO dispatch_records (scope, id, value) VALUES (?, ?, ?)').run(
          row.scope,
          record.id,
          JSON.stringify(record),
        );
      } else {
        assert.equal(mode, 'verify');
        const saved = db
          .prepare('SELECT value FROM dispatch_records WHERE scope = ? AND id = ?')
          .get(row.scope, record.id);
        assert.deepEqual(JSON.parse(saved.value), record);
        db.prepare('DELETE FROM dispatch_records WHERE scope = ? AND id = ?').run(
          row.scope,
          record.id,
        );
      }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}
assert.equal(owners, 1);
