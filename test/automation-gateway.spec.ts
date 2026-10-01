import assert from 'node:assert/strict';

import { listNativeAutomations, nativeAutomation } from '../agent/automation-gateway.ts';

const job = (id: string) => ({
  id,
  agentId: 'a',
  declarationKey: `owned:${id}`,
  enabled: false,
  configRevision: id,
  schedule: {},
  payload: {},
  state: {},
});
describe('agent/automation-gateway', () => {
  it('should read all pages including disabled jobs without mutation', async () => {
    const offsets: unknown[] = [];
    const result = await listNativeAutomations(async (method, params) => {
      assert.equal(method, 'cron.list');
      assert.equal(params.includeDisabled, true);
      assert.equal(params.includeDeliveryPreviews, false);
      offsets.push(params.offset);
      return params.offset === 0
        ? { jobs: Array.from({ length: 200 }, (_, n) => job(String(n))), hasMore: true }
        : { jobs: [job('last')], hasMore: false };
    });
    assert.equal(result.length, 201);
    assert.deepEqual(offsets, [0, 200]);
  });
  it('should reject malformed partial duplicate and unversioned native snapshots', async () => {
    await assert.rejects(
      listNativeAutomations(async () => ({ jobs: [] })),
      /response-invalid/u,
    );
    await assert.rejects(
      listNativeAutomations(async () => ({ jobs: [job('one')], hasMore: true })),
      /snapshot-diverged/u,
    );
    await assert.rejects(
      listNativeAutomations(async () => ({ jobs: [job('one'), job('one')], hasMore: false })),
      /snapshot-diverged/u,
    );
    assert.throws(
      () => nativeAutomation({ ...job('one'), configRevision: undefined }),
      /response-invalid/u,
    );
  });
});
