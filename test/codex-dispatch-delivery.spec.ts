import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import acknowledgeDispatchDelivery from '../agent/codex-dispatch-delivery.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import IntakeRecordStore, { intakeLocation } from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

describe('agent/codex-dispatch-delivery', () => {
  it('should replay delivery after an interrupted save and preserve unrelated cards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dispatch-delivery-'));
    try {
      const fixture = intakeFixture();
      const intakeStore = new IntakeRecordStore(
        intakeLocation({
          runtime: 'codex',
          root,
          namespace: '/profile',
          workspaceDir: '/workspace',
          agentId: 'receiver',
        }),
      );
      await scanAssignments({
        store: intakeStore,
        workspaceDir: '/workspace',
        agentId: 'receiver',
        policy: fixture.policy,
        policyDigest: 'approved-policy',
        now: baseline,
        activate: true,
        connect: async () => fixture.client,
        assertCurrent: async () => {},
      });
      const card = (id: string) => ({ id: id.repeat(64), message: 'retained card', notify: false });
      await intakeStore.exclusive(async (state, save) => {
        state!.notices = [card('a'), card('c')];
        await save(state!);
      });
      const store = new CodexDispatchStore(root, intakeStore.location.scope);
      await store.exclusive(async (state, save) => {
        state.notices = [card('b'), card('d')];
        state.reports = [
          { response: 'delivered', createdAt: baseline, notices: [card('a').id, card('b').id] },
          { response: 'pending', createdAt: baseline, notices: [card('c').id, card('d').id] },
        ];
        await save();
      });
      const acknowledge = (failSave = false, delivered = ['delivered']) =>
        store.exclusive(async (state, save) =>
          acknowledgeDispatchDelivery({
            state,
            intakeStore,
            deliveredReports: async () => delivered,
            save: failSave
              ? async () => {
                  throw new Error('interrupted save');
                }
              : save,
          }),
        );
      await acknowledge(false, []);
      assert.equal((await intakeStore.read())!.notices!.length, 2);
      await assert.rejects(acknowledge(true), /interrupted save/);
      assert.deepEqual((await intakeStore.read())!.notices, [card('c')]);
      assert.equal((await store.read()).reports!.length, 2);
      await acknowledge();
      assert.deepEqual((await intakeStore.read())!.notices, [card('c')]);
      assert.deepEqual((await store.read()).notices, [card('d')]);
      assert.equal((await store.read()).reports![0]!.response, 'pending');
      await acknowledge();
      assert.equal((await store.read()).reports!.length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
