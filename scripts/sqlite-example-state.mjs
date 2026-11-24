import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Each hosted example owns the entire disposable OpenClaw state directory.
export function agentDatabases() {
  const root = join(process.env.OPENCLAW_STATE_DIR, 'agent-system-storage');
  return readdirSync(root)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => join(root, name));
}

export function readExampleState(kind) {
  const result = [];
  for (const path of agentDatabases()) {
    const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
    try {
      if (kind === 'replies') {
        for (const row of db.prepare('SELECT value FROM reply_drafts ORDER BY rowid').all())
          result.push(JSON.parse(row.value));
        continue;
      }
      if (kind !== 'dispatch' && kind !== 'intake') throw new Error('unknown journal: ' + kind);
      db.exec('BEGIN');
      const records = db.prepare(
        'SELECT value FROM ' + kind + '_records WHERE scope = ? ORDER BY rowid',
      );
      for (const row of db
        .prepare('SELECT scope, value FROM ' + kind + '_state ORDER BY rowid')
        .all()) {
        if (kind === 'dispatch' && row.scope.startsWith('pickup:')) continue;
        result.push({
          ...JSON.parse(row.value),
          records: records.all(row.scope).map((record) => JSON.parse(record.value)),
        });
      }
    } finally {
      db.close();
    }
  }
  return result;
}

if (import.meta.main) {
  for (const row of readExampleState(process.argv[2]))
    process.stdout.write(JSON.stringify(row) + '\n');
}
