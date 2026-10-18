import { createGitTool } from '../tools/git/tool.ts';
import { assertValidationParity } from './tool-validation-fixture.ts';

describe('tools/git/tool validation', () => {
  it('should preserve safe boundary reasons across policy, command, and native calls', async () => {
    await assertValidationParity(
      createGitTool(),
      {
        schemaVersion: 1,
        agent: { id: 'data', name: 'Test Agent', email: 'test@example.com' },
        git: {},
      },
      [
        {
          argv: ['-c', 'user.name=private-argument-sentinel', 'status'],
          signals: [/configuration/u, /boundaries/u],
        },
        {
          argv: ['--exec-path=private-executable-sentinel', 'status'],
          signals: [/executable/u, /boundaries/u],
        },
        {
          argv: ['config', 'user.name', 'private-argument-sentinel'],
          signals: [/agent\.yaml/u, /may not be mutated/u],
        },
        {
          argv: ['commit', '--no-gpg-sign', '-m', 'private-argument-sentinel'],
          signals: [/signing/u, /may not be overridden/u],
        },
        {
          argv: ['status'],
          cwd: '../private-directory-sentinel',
          signals: [/working directory/u, /inside/u],
        },
        {
          argv: ['worktree', 'add', 'private-directory-sentinel'],
          signals: [/worktree/u, /agent_system_git_worktree/u],
        },
        { argv: ['--no-pager'], signals: [/command/u, /missing/u] },
      ],
    );
  });
});
