import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
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
    const store = new NotificationRoutingReceiptStore({
      currentUid: process.getuid?.(),
      rootDir: root,
    });

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

  it('should reject unusable stores and invalid receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));

    await assert.rejects(
      new NotificationRoutingReceiptStore({}).write(receipt),
      /receipt store is unavailable/u,
    );
    await assert.rejects(
      new NotificationRoutingReceiptStore({ rootDir: root }).write({
        ...receipt,
        accountId: '../data',
        agentId: '../data',
      }),
      /receipt is invalid/u,
    );
    await assert.rejects(
      new NotificationRoutingReceiptStore({ rootDir: root }).write({
        ...receipt,
        unexpected: true,
      } as never),
      /receipt is invalid/u,
    );
  });

  it('should reject invalid and non-regular receipt paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    const agentDir = join(root, 'data');
    await mkdir(agentDir, { mode: 0o700 });
    await writeFile(
      join(agentDir, 'notification-routing.json'),
      JSON.stringify({ ...receipt, accountId: 'other' }),
      { mode: 0o600 },
    );
    const store = new NotificationRoutingReceiptStore({ rootDir: root });
    await assert.rejects(store.read('data'), /routing receipt is invalid/u);

    const linkedRoot = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    const linkedAgentDir = join(linkedRoot, 'data');
    const target = join(linkedRoot, 'target.json');
    await mkdir(linkedAgentDir, { mode: 0o700 });
    await writeFile(target, JSON.stringify(receipt));
    await symlink(target, join(linkedAgentDir, 'notification-routing.json'));
    await assert.rejects(
      new NotificationRoutingReceiptStore({ rootDir: linkedRoot }).read('data'),
      /receipt may not be a symbolic link/u,
    );
  });

  it('should reject public receipt state and symbolic-link directories', async () => {
    const publicRoot = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    await chmod(publicRoot, 0o755);
    await assert.rejects(
      new NotificationRoutingReceiptStore({ rootDir: publicRoot }).write(receipt),
      /directories must be private/u,
    );

    const root = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    const store = new NotificationRoutingReceiptStore({ rootDir: root });
    await store.write(receipt);
    const currentUid = process.getuid?.();
    if (currentUid !== undefined) {
      await assert.rejects(
        new NotificationRoutingReceiptStore({ currentUid: currentUid + 1, rootDir: root }).read(
          'data',
        ),
        /owned by the current user/u,
      );
    }
    await chmod(join(root, 'data', 'notification-routing.json'), 0o644);
    await assert.rejects(store.read('data'), /receipt must be private/u);

    const linkedRoot = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    const target = await mkdtemp(join(tmpdir(), 'agent-system-notification-target-'));
    await symlink(target, join(linkedRoot, 'data'));
    await assert.rejects(
      new NotificationRoutingReceiptStore({ rootDir: linkedRoot }).write(receipt),
      /directories must be real directories/u,
    );
  });

  it('should reject oversized receipt state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    const agentDir = join(root, 'data');
    await mkdir(agentDir, { mode: 0o700 });
    await writeFile(join(agentDir, 'notification-routing.json'), 'x'.repeat(16 * 1024 + 1), {
      mode: 0o600,
    });

    await assert.rejects(
      new NotificationRoutingReceiptStore({ rootDir: root }).read('data'),
      /receipt exceeds its size limit/u,
    );
  });

  it('should reject invalid utf-8 receipt state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-notification-store-'));
    const agentDir = join(root, 'data');
    await mkdir(agentDir, { mode: 0o700 });
    await writeFile(join(agentDir, 'notification-routing.json'), Buffer.from([0xc3, 0x28]), {
      mode: 0o600,
    });

    await assert.rejects(
      new NotificationRoutingReceiptStore({ rootDir: root }).read('data'),
      /receipt is invalid/u,
    );
  });
});
