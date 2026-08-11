import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import NotificationRoutingReceiptStore from '../channels/github/lib/routing-receipt-store.ts';
import type { NotificationRoutingReceipt } from '../channels/github/utils/routing.ts';

const receipt: NotificationRoutingReceipt = {
  schemaVersion: 1,
  accountId: 'data',
  agentId: 'data',
  channelId: 'agent-system-github',
  workspaceDir: '/workspace/data',
};

describe('channels/github/lib/routing-receipt-store', () => {
  it('should persist, read, and remove a private routing receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    const store = new NotificationRoutingReceiptStore(root);

    await store.write(receipt);

    const agentDir = join(root, 'data');
    const receiptPath = join(agentDir, 'notification-routing.json');
    assert.deepEqual(await store.read('data'), receipt);
    assert.equal((await lstat(agentDir)).mode & 0o777, 0o700);
    assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
    assert.equal(await store.remove('data'), true);
    assert.equal(await store.read('data'), undefined);
    assert.equal(await store.remove('data'), false);
  });

  it('should reject unusable stores and invalid agent ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));

    await assert.rejects(
      new NotificationRoutingReceiptStore(undefined).write(receipt),
      /receipt store is unavailable/u,
    );
    await assert.rejects(
      new NotificationRoutingReceiptStore(root).write({
        ...receipt,
        accountId: '../data',
        agentId: '../data',
      }),
      /receipt store is unavailable/u,
    );
  });

  it('should reject invalid and non-regular receipt paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    const agentDir = join(root, 'data');
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, 'notification-routing.json'),
      JSON.stringify({ ...receipt, accountId: 'other' }),
    );
    const store = new NotificationRoutingReceiptStore(root);
    await assert.rejects(store.read('data'), /routing receipt is invalid/u);

    const linkedRoot = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    const linkedAgentDir = join(linkedRoot, 'data');
    const target = join(linkedRoot, 'target.json');
    await mkdir(linkedAgentDir);
    await writeFile(target, JSON.stringify(receipt));
    await symlink(target, join(linkedAgentDir, 'notification-routing.json'));
    await assert.rejects(
      new NotificationRoutingReceiptStore(linkedRoot).read('data'),
      /receipt must be a regular file/u,
    );
  });
});
