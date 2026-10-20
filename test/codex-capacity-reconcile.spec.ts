import assert from 'node:assert/strict';
import reconcile from '../agent/codex-capacity-reconcile.ts';
import codexCapacity, {
  legacyRetiredReservation,
  codexUnresolvedRetirement,
} from '../agent/codex-capacity.ts';
import pending, { issueKey } from '../agent/dispatch-pending.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { IntakeState, IntakeRecord } from '../channels/github/intake/record-store.ts';

function record(): DispatchRecord {
  return {
    phase: 'blocked',
    request: { prompt: 'request' },
    sourceThreadId: 'intake',
    createdAt: 1,
    retired: { at: 2, by: 'operator' },
  } as DispatchRecord;
}
describe('agent/codex-capacity-reconcile', () => {
  it('should preserve a legacy retirement without claiming inactivity or allowing same-issue duplication', () => {
    const owner = record();
    const item = {
      id: 'new',
      scope: 'scope',
      receiving: { nodeId: 'user' },
      repository: { nodeId: 'repo' },
      issue: { nodeId: 'issue' },
      assignment: { createdAt: new Date(3).toISOString() },
    } as IntakeRecord;
    owner.issueKey = issueKey(item);
    const state = { records: [owner] };
    assert.equal(legacyRetiredReservation(owner), true);
    assert.equal(codexCapacity([owner], 3).occupied, 0);
    assert.equal(owner.nativeInactive, undefined);
    assert.deepEqual(
      pending(state, { records: [item] } as IntakeState, codexUnresolvedRetirement),
      [],
    );
    owner.capacityObservation = { at: 10, code: 'dispatch-capacity-native-active' };
    assert.equal(codexCapacity([owner], 3).occupied, 1);
    owner.nativeInactive = true;
    assert.equal(
      pending(state, { records: [item] } as IntakeState, codexUnresolvedRetirement).length,
      1,
    );
    delete owner.nativeInactive;
    owner.reservationVersion = 1;
    assert.equal(codexCapacity([owner], 3).occupied, 1);
  });
  it('should release a known ended native turn despite missing workspace files', async () => {
    const owner = {
      ...record(),
      reservationVersion: 1 as const,
      threadId: 'child',
      worktree: '/removed',
    };
    const native = {
      find: async (input: { observationOnly?: boolean }) => {
        assert.equal(input.observationOnly, true);
        return {
          id: 'child',
          cwd: '/removed',
          status: 'notLoaded',
          turnId: 'ended',
          turnEnded: true,
        };
      },
      unsubmittedCreation: async () => {
        assert.fail('known creation cannot become non-submission');
      },
    };
    await reconcile(owner, native, 'current', 20);
    assert.equal(owner.nativeInactive, true);
    assert.equal(codexCapacity([owner], 3).occupied, 0);
    assert.equal(owner.request!.prompt, 'request');
    assert.equal(structuredClone(owner).capacityObservation?.turnId, 'ended');
  });
  it('should preserve missing, active, unreadable and terminal-looking but unended reservations', async () => {
    for (const found of [
      undefined,
      { id: 'child', cwd: '/missing', status: 'active', turnId: 'run', turnEnded: true },
      { id: 'child', cwd: '/missing', status: 'notLoaded', turnId: 'run', turnEnded: false },
    ]) {
      const owner = {
        ...record(),
        reservationVersion: 1 as const,
        threadId: 'child',
        nativeInactive: true,
      };
      await reconcile(
        owner,
        {
          find: async () => found,
          unsubmittedCreation: async () => {
            assert.fail();
          },
        },
        'current',
        20,
      );
      assert.equal(owner.nativeInactive, undefined);
      assert.equal(codexCapacity([owner], 3).occupied, 1);
      assert.ok(owner.capacityObservation?.code);
    }
    const owner = { ...record(), reservationVersion: 1 as const, threadId: 'child' };
    await reconcile(
      owner,
      {
        find: async () => {
          throw new Error('dispatch-native-history-incomplete');
        },
        unsubmittedCreation: async () => undefined,
      },
      'current',
      20,
    );
    assert.equal(owner.capacityObservation?.code, 'dispatch-native-history-incomplete');
    assert.equal(codexCapacity([owner], 3).occupied, 1);
  });
  it('should reconcile retired unknown creation only from complete non-submission evidence', async () => {
    const owner = record();
    const native = {
      find: async () => {
        assert.fail('ordinary polling must not repeatedly search all native history');
      },
      unsubmittedCreation: async () => undefined as { turnId: string } | undefined,
    };
    await reconcile(owner, native, 'current', 20);
    assert.equal(owner.capacityObservation?.code, 'dispatch-capacity-creation-unresolved');
    assert.equal(owner.nativeInactive, undefined);
    native.unsubmittedCreation = async () => ({ turnId: 'preparation' });
    await reconcile(owner, native, 'current', 30);
    assert.equal(owner.nativeInactive, true);
    assert.equal(owner.capacityObservation?.code, 'dispatch-capacity-never-submitted');
    assert.ok(owner.request);
    assert.ok(owner.retired);
  });
  it('should retain a discovered active reservation through restart and unreadable history', async () => {
    let owner = record();
    await reconcile(
      owner,
      {
        find: async () => ({
          id: 'discovered',
          cwd: '/removed',
          status: 'active',
          turnId: 'live',
          turnEnded: false,
        }),
        unsubmittedCreation: async () => {
          assert.fail();
        },
      },
      'current',
      20,
      true,
    );
    assert.equal(codexCapacity([owner], 3).occupied, 1);
    owner = structuredClone(owner);
    await reconcile(
      owner,
      {
        find: async (input) => {
          assert.equal(input.threadId, 'discovered');
          throw new Error('dispatch-native-history-incomplete');
        },
        unsubmittedCreation: async () => {
          assert.fail();
        },
      },
      'current',
      30,
    );
    assert.equal(owner.capacityObservation?.threadId, 'discovered');
    assert.equal(codexCapacity([owner], 3).occupied, 1);
    assert.equal(owner.nativeInactive, undefined);
  });
  it('should release cancelled continuation capacity only after native terminal proof', async () => {
    const owner = {
      ...record(),
      retired: undefined,
      phase: 'complete' as const,
      threadId: 'child',
      continuation: { phase: 'cancelled', attempt: {} },
    } as DispatchRecord;
    assert.equal(codexCapacity([owner], 3).occupied, 1);
    await reconcile(
      owner,
      {
        find: async () => ({
          id: 'child',
          cwd: '/removed',
          status: 'idle',
          turnId: 'end',
          turnEnded: true,
        }),
        unsubmittedCreation: async () => undefined,
      },
      'current',
      30,
    );
    assert.equal(codexCapacity([owner], 3).occupied, 0);
    assert.ok(owner.continuation?.attempt);
  });
});
