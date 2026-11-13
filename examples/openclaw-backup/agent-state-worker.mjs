import assert from 'node:assert/strict';

import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from 'openclaw/plugin-sdk/sqlite-worker-runtime';

// The native agent executor owns the connection, schema, admission and close.
export function bindSqliteWorkerBackend(_input, context) {
  const database = context.database;
  let closed = false;
  const transact = (operation) =>
    runSqliteImmediateTransactionSync(
      database,
      () => {
        context.admit('transaction');
        return operation();
      },
      {
        withCommit(commit) {
          context.admit('commit');
          commit();
        },
      },
    );
  return {
    execute(command) {
      assert.equal(closed, false, 'backup fixture worker is closed');
      if (command.type === 'initialize') {
        transact(() =>
          database.exec(
            'CREATE TABLE IF NOT EXISTS backup_fixture (id TEXT PRIMARY KEY, value BLOB NOT NULL);',
          ),
        );
        database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        return;
      }
      assert.equal(command.type, 'seed');
      transact(() =>
        database.exec(
          "INSERT OR REPLACE INTO backup_fixture VALUES ('durable', 'committed-wal-record');",
        ),
      );
      return context.databasePath;
    },
    assertSettled() {
      assertTransactionUsable(database);
      assert.equal(database.isOpen, true);
      assert.equal(database.isTransaction, false);
    },
    close() {
      closed = true;
    },
  };
}
