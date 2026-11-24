import assert from 'node:assert/strict';
import IntakeRecordStore, {
  fileIntakePersistence,
  intakeLocation,
} from '../channels/github/intake/record-store.ts';
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
    const persistence = fileIntakePersistence(location);
    const store = new IntakeRecordStore(location, persistence);
    for (const code of ['EPERM', 'EACCES']) {
      const denial = Object.assign(new Error('denied'), { code });
      persistence.file.read = async () => {
        throw denial;
      };
      await assert.rejects(
        store.read(),
        (error: unknown) => error === denial && codexHostAccess(error),
      );
    }
    persistence.file.read = async () => '{';
    await assert.rejects(store.read(), { code: 'intake-state-invalid' });
  });
});
