import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { openOpenClawAgentSqliteWorkerStoreV2 } from 'openclaw/plugin-sdk/sqlite-runtime';

const [mode, path] = process.argv.slice(2);
if (!path || (mode !== 'seed' && mode !== 'verify'))
  throw new Error('Use seed <ready-file> or verify <snapshot-database>.');

if (mode === 'seed') {
  const lifetime = new AbortController();
  const stopped = Promise.withResolvers();
  const stop = () => {
    lifetime.abort();
    stopped.resolve();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const assertCurrent = () => lifetime.signal.throwIfAborted();
  const store = await openOpenClawAgentSqliteWorkerStoreV2(
    { agentId: 'backup-tanaabot' },
    { version: 2, assertCurrent },
    { moduleUrl: new URL('./agent-state-worker.mjs', import.meta.url).href },
  );
  try {
    await store.prepare();
    const databasePath = await store.run(async (scope) => {
      await scope.execute({ type: 'initialize' });
      return scope.execute({ type: 'seed' });
    }, assertCurrent);
    assertCurrent();
    writeFileSync(path, `${databasePath}\n`, { mode: 0o600 });
    // Retain the native executor while backup captures its committed WAL.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await stopped.promise;
    } finally {
      clearInterval(keepAlive);
    }
  } finally {
    await store.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
} else {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      database.prepare("SELECT value FROM backup_fixture WHERE id = 'durable'").get().value,
      'committed-wal-record',
    );
  } finally {
    database.close();
  }
}
