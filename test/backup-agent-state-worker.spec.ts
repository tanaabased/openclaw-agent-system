import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { bindSqliteWorkerBackend } from '../examples/openclaw-backup/agent-state-worker.mjs';

describe('examples/openclaw-backup/agent-state-worker', () => {
  it('should commit through worker admission and leave the connection with its owner', () => {
    const database = new DatabaseSync(':memory:');
    const stages: string[] = [];
    const worker = bindSqliteWorkerBackend(undefined, {
      database,
      databasePath: '/fixture/agent.sqlite',
      admit(stage: string) {
        stages.push(stage);
      },
    });
    try {
      worker.execute({ type: 'initialize' });
      stages.length = 0;
      assert.equal(worker.execute({ type: 'seed' }), '/fixture/agent.sqlite');
      assert.deepEqual(stages, ['transaction', 'commit']);
      assert.equal(
        database.prepare('SELECT value FROM backup_fixture').get()?.value,
        'committed-wal-record',
      );
      worker.assertSettled();
      assert.throws(() => worker.execute({ type: 'unknown' }));
      worker.close();
      assert.equal(database.isOpen, true);
      assert.throws(() => worker.execute({ type: 'seed' }), /closed/);
    } finally {
      database.close();
    }
  });

  it('should roll back a seed when native commit admission is revoked', () => {
    const database = new DatabaseSync(':memory:');
    let revoked = false;
    const worker = bindSqliteWorkerBackend(undefined, {
      database,
      admit(stage: string) {
        if (revoked && stage === 'commit') throw new Error('authority revoked');
      },
    });
    try {
      worker.execute({ type: 'initialize' });
      revoked = true;
      assert.throws(() => worker.execute({ type: 'seed' }), /authority revoked/);
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM backup_fixture').get()?.count,
        0,
      );
      worker.assertSettled();
    } finally {
      worker.close();
      database.close();
    }
  });
});
