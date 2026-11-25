import { bindSqliteStorage } from '../agent/storage/agent-database.ts';
import codexStorageLocation from '../agent/storage/codex-storage.ts';
import assert from 'node:assert/strict';
import IntakeRecordStore, { intakeLocation } from '../channels/github/intake/record-store.ts';
import codexHostAccess from '../agent/codex-host-access.ts';

describe('intake host access', () => {
  it('should preserve read permission errors for the bounded native approval retry', async () => {
    const location = intakeLocation({
      runtime: 'codex',
      root: '/unused',
      namespace: 'test',
      workspaceDir: '/unused',
      agentId: 'test',
    });
    const agent = bindSqliteStorage(codexStorageLocation('/unused'), 'test').agent;
    const store = new IntakeRecordStore(location, agent);
    for (const code of ['EPERM', 'EACCES']) {
      const denial = Object.assign(new Error('denied'), { code });
      agent.readIntake = async () => {
        throw denial;
      };
      await assert.rejects(
        store.read(),
        (error: unknown) => error === denial && codexHostAccess(error),
      );
    }
  });
});
