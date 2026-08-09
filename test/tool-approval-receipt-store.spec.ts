import assert from 'node:assert/strict';

import AgentSystemToolApprovalReceiptStore, {
  type AgentSystemApprovalReceipt,
} from '../lib/tool-approval-receipt-store.ts';

const receipt: AgentSystemApprovalReceipt = {
  agentId: 'data',
  input: { argv: ['repo', 'delete', 'owner/repository', '--yes'] },
  toolCallId: 'tool-call',
  toolId: 'github',
};

describe('lib/tool-approval-receipt-store', () => {
  it('should bind a receipt to its exact call context and consume it once', () => {
    const store = new AgentSystemToolApprovalReceiptStore();

    store.record(receipt);
    assert.equal(store.consume({ ...receipt, toolCallId: 'other-call' }), false);
    assert.equal(store.consume(receipt), true);
    assert.equal(store.consume(receipt), false);

    for (const mismatch of [
      { ...receipt, agentId: 'other-agent' },
      { ...receipt, toolId: 'other-tool' },
      { ...receipt, input: { argv: ['repo', 'delete', 'owner/other', '--yes'] } },
    ]) {
      store.record(receipt);
      assert.equal(store.consume(mismatch), false);
      assert.equal(store.consume(receipt), false);
    }
  });

  it('should expire receipts using the injected clock', () => {
    let now = 0;
    const store = new AgentSystemToolApprovalReceiptStore({ now: () => now });

    store.record(receipt);
    now = 24 * 60 * 60 * 1_000;

    assert.equal(store.consume(receipt), false);
  });

  it('should evict the oldest receipt when the bounded store fills', () => {
    const store = new AgentSystemToolApprovalReceiptStore({ now: () => 0 });

    for (let index = 0; index <= 1_024; index += 1) {
      store.record({ ...receipt, toolCallId: `tool-call-${index}` });
    }

    assert.equal(store.consume({ ...receipt, toolCallId: 'tool-call-0' }), false);
    assert.equal(store.consume({ ...receipt, toolCallId: 'tool-call-1' }), true);
    assert.equal(store.consume({ ...receipt, toolCallId: 'tool-call-1024' }), true);
  });
});
