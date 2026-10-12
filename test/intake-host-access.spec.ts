import assert from 'node:assert/strict';
import IntakeRecordStore, { intakeLocation } from '../channels/github/intake/record-store.ts';
import codexHostAccess from '../agent/codex-host-access.ts';

describe('intake host access', () => {
  it('should preserve read permission errors for the bounded native approval retry', async () => {
    const store = new IntakeRecordStore(
      intakeLocation({
        runtime: 'codex',
        root: '/unused',
        namespace: 'test',
        workspaceDir: '/unused',
        agentId: 'test',
      }),
    );
    for (const code of ['EPERM', 'EACCES']) {
      const denial = Object.assign(new Error('denied'), { code });
      store.file.read = async () => {
        throw denial;
      };
      await assert.rejects(
        store.read(),
        (error: unknown) => error === denial && codexHostAccess(error),
      );
    }
    store.file.read = async () => '{';
    await assert.rejects(store.read(), { code: 'intake-state-invalid' });
  });
});
