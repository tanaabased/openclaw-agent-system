import assert from 'node:assert/strict';

import assignmentStage, {
  GitHubAssignmentStageError,
} from '../channels/github/conversation/assignment-stage.ts';

describe('channels/github/conversation/assignment-stage', () => {
  it('should retain the innermost failed stage and original cause', async () => {
    const cause = new Error('private provider response');
    await assert.rejects(
      assignmentStage('implementation', () =>
        assignmentStage('delivery', () => {
          throw cause;
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof GitHubAssignmentStageError);
        assert.equal(error.code, 'github-notification-assignment-delivery-failed');
        assert.equal(error.cause, cause);
        assert.equal(error.message.includes(cause.message), false);
        return true;
      },
    );
  });

  it('should return successful values unchanged', async () => {
    const value = { status: 'published' };
    assert.equal(await assignmentStage('publication', () => value), value);
  });
});
