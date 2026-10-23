import assert from 'node:assert/strict';

import type { DispatchGit } from '../agent/codex-dispatch-project.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import prepareBranch, { verifyCodexWorkBranch } from '../agent/codex-work-branch.ts';

const base = 'a'.repeat(40);
const intake = {
  repository: {
    nodeId: 'R_repo',
    databaseId: 10,
    owner: { login: 'owner', nodeId: 'O_owner' },
    name: 'repo',
  },
  issue: { nodeId: 'I_issue', databaseId: 20, number: 3 },
};
function record(id = 'b'.repeat(64)): DispatchRecord {
  return {
    id,
    intakeId: 'c'.repeat(64),
    issueKey: 'd'.repeat(64),
    sourceThreadId: 'intake',
    phase: 'complete',
    createdAt: 1,
    manifestDigest: 'manifest',
    threadId: 'child',
    project: {
      id: 'project',
      path: '/source',
      commonDir: '/common',
      ref: 'origin/main',
      commit: base,
    },
    worktree: '/worktree',
    context: JSON.stringify({ title: 'Repair the defect' }),
    worktreeAttemptId: id,
  };
}
function fixture() {
  const state = {
    current: '',
    head: base,
    dirty: '',
    collision: '',
    saves: 0,
    switches: 0,
    lost: false,
  };
  const owned = record();
  const git: DispatchGit = async (_cwd, argv) => {
    if (argv[0] === 'branch') return state.current;
    if (argv[0] === 'rev-parse') return state.head;
    if (argv[0] === 'status') return state.dirty;
    if (argv[0] === 'for-each-ref') return state.collision;
    if (argv[0] === 'switch') {
      assert.equal(state.saves > 0, true, 'intent must precede git mutation');
      assert.equal(argv.at(-1), base);
      assert.equal(argv.includes('-C'), false);
      state.switches++;
      state.current = argv[3]!;
      if (state.lost) throw new Error('lost git response');
    }
    return '';
  };
  const input = {
    record: owned,
    intake,
    agentId: 'receiver',
    workspace: '/workspace',
    git,
    save: async () => {
      state.saves++;
    },
  };
  return { state, owned, input };
}
describe('agent/codex-work-branch', () => {
  it('should reuse the exact attempt branch through title changes and lost git responses', async () => {
    const { state, owned, input } = fixture();
    state.lost = true;
    await assert.rejects(prepareBranch(input), /lost git response/);
    const branch = owned.worktreeBranch;
    assert.ok(branch);
    const recovered = structuredClone(owned);
    recovered.context = JSON.stringify({ title: 'Renamed issue' });
    state.head = 'f'.repeat(40);
    state.dirty = ' M ongoing-work';
    assert.equal(await prepareBranch({ ...input, record: recovered }), branch);
    assert.equal(await verifyCodexWorkBranch(recovered, intake, input.git), branch);
    assert.equal(state.switches, 1);
    assert.equal(state.dirty, ' M ongoing-work');
  });

  it('should distinguish a fresh attempt and preserve retired branch ownership', async () => {
    const { state, owned, input } = fixture();
    const retired = await prepareBranch(input);
    owned.retired = { at: 2, by: 'operator' };
    const fresh = record('e'.repeat(64));
    state.current = '';
    const branch = await prepareBranch({ ...input, record: fresh });
    assert.notEqual(branch, retired);
    assert.equal(owned.worktreeBranch, retired);
    assert.equal(state.switches, 2);
    assert.equal(await prepareBranch({ ...input, record: fresh }), branch);
    assert.equal(state.switches, 2);
  });

  for (const reason of ['foreign branch', 'advanced head', 'dirty checkout', 'branch collision'])
    it(`should preserve work on ${reason}`, async () => {
      const { state, owned, input } = fixture();
      if (reason === 'foreign branch') state.current = 'retired-same-issue';
      if (reason === 'advanced head') state.head = 'f'.repeat(40);
      if (reason === 'dirty checkout') state.dirty = ' M work';
      if (reason === 'branch collision') state.collision = 'refs/heads/existing';
      const before = { ...state };
      await assert.rejects(
        prepareBranch(input),
        /dispatch-branch-(owner-mismatch|base-changed|exists)/,
      );
      assert.deepEqual(state, before);
      assert.equal(owned.worktreeBranch, undefined);
    });

  it('should reject changed attempt identity and unbound same-issue branches', async () => {
    const { owned, input, state } = fixture();
    owned.worktreeAttemptId = 'e'.repeat(64);
    await assert.rejects(prepareBranch(input), /dispatch-branch-owner-mismatch/);
    delete owned.worktreeAttemptId;
    state.current = 'receiver-3-repair-the-defect-old';
    await assert.rejects(
      verifyCodexWorkBranch(owned, intake, input.git),
      /dispatch-branch-ownership-required/,
    );
    await assert.rejects(prepareBranch(input), /dispatch-branch-owner-mismatch/);
    assert.equal(state.switches, 0);
  });
});
