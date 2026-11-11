import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import { dispatchRecordSchema } from '../agent/codex-dispatch-state.ts';
import dispatchOwnershipSchema from '../agent/dispatch-ownership-schema.ts';
import { openclawDispatchRecordSchema } from '../agent/openclaw-dispatch-state.ts';

for (const [runtime, schema] of [
  ['codex', dispatchRecordSchema],
  ['openclaw', openclawDispatchRecordSchema],
] as const) {
  describe(`agent/dispatch-ownership-schema ${runtime}`, () => {
    const ownership = dispatchOwnershipSchema(schema);
    const record = () => ({
      id: 'a'.repeat(64),
      intakeId: 'b'.repeat(64),
      issueKey: 'c'.repeat(64),
      sourceThreadId: 'coordinator',
      threadId: 'other-chat',
      worktree: '/other',
      createdAt: 1,
      manifestDigest: 'manifest',
    });
    const binding = () => ({
      repositoryId: 'repository',
      issueId: 'issue',
      threadId: 'other-chat',
      worktree: '/other',
      branch: 'other-branch',
    });

    it('should ignore authored payloads and pending effect details but require their destination', () => {
      const other = {
        ...record(),
        delivery: {
          binding: binding(),
          title: 42,
          body: { opaque: true },
          pendingPush: { head: 'damaged', attempted: true },
        },
      };
      assert.equal(Value.Check(schema, other), false);
      assert.equal(Value.Check(ownership, other), true);
      for (const field of ['threadId', 'worktree', 'branch', 'repositoryId', 'issueId']) {
        assert.equal(
          Value.Check(ownership, {
            ...other,
            delivery: {
              ...other.delivery,
              binding: { ...binding(), [field]: 42 },
            },
          }),
          false,
          field,
        );
      }
      assert.equal(Value.Check(ownership, { ...other, delivery: null }), false);
      assert.equal(Value.Check(ownership, { ...other, delivery: { title: 42 } }), false);
    });

    it('should project only native request and checkout identities from the runtime schema', () => {
      const request = runtime === 'openclaw' ? { key: 'other-chat', cwd: '/other' } : {};
      const other = { ...record(), request: { ...request, title: 42, prompt: null, model: 42 } };
      assert.equal(Value.Check(schema, other), false);
      assert.equal(Value.Check(ownership, other), true);
      assert.equal(Value.Check(ownership, { ...other, request: null }), false);
      if (runtime === 'openclaw') {
        assert.equal(Value.Check(ownership, { ...other, request: { ...request, cwd: 42 } }), false);
      } else {
        assert.equal(
          Value.Check(ownership, { ...other, project: { commonDir: '/repo/.git', commit: 42 } }),
          true,
        );
        assert.equal(Value.Check(ownership, { ...other, project: { commonDir: 42 } }), false);
      }
    });

    it('should retain provider and manual issue identities without validating their prose or selections', () => {
      const other = {
        ...record(),
        adoptedPullRequest: {
          pullRequestNodeId: 'pr',
          pullRequestNumber: 3,
          branch: 'feature',
          title: 42,
          body: null,
        },
        manualIssue: {
          id: 'other',
          scope: 'scope',
          receiving: { nodeId: 'receiver' },
          repository: { nodeId: 'repo' },
          issue: { nodeId: 'issue' },
          initiation: { session: 'coordinator' },
          selections: { assessment: null },
        },
      };
      assert.equal(Value.Check(ownership, other), true);
      assert.equal(
        Value.Check(ownership, {
          ...other,
          manualIssue: {
            ...other.manualIssue,
            issue: { nodeId: 42 },
          },
        }),
        false,
      );
      assert.equal(
        Value.Check(ownership, {
          ...other,
          adoptedPullRequest: {
            ...other.adoptedPullRequest,
            branch: 42,
          },
        }),
        false,
      );
    });
  });
}
