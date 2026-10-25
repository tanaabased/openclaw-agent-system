import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { testResourceObject } from './test-resource-cleanup.ts';
import {
  issueMarker,
  testBucket,
  type TestResourceAccount,
  type TestResourceReceipt,
} from './test-resource-receipts.ts';

/** Publish intent before creating a fixture, and retain IDs before returning to assertions. */
export default async function createTestIssue(input: {
  receipt: TestResourceReceipt;
  title: string;
  body: string;
  account: TestResourceAccount;
  checkpoint(receipt: TestResourceReceipt): Promise<void>;
  create(body: { title: string; body: string }): Promise<unknown>;
}) {
  const { receipt, title, body, account } = input;
  assert.ok(title && body && body.length < 64 * 1024, 'test-resource-issue-input-invalid');
  assert.ok(
    receipt.resources.filter(({ kind }) => kind === 'issue').length < 3,
    'test-resource-issue-limit',
  );
  const receiptId = randomUUID();
  const resource = {
    kind: 'issue' as const,
    receiptId,
    repository: testBucket as typeof testBucket,
    account,
    marker: issueMarker(receipt.source, receiptId),
  };
  receipt.resources.push(resource);
  receipt.sequence++;
  await input.checkpoint(receipt);
  // A failed or uncertain creation is never replayed. The durable nonce permits reconciliation.
  const issue = testResourceObject(
    await input.create({ title, body: `${body}\n\n${resource.marker}` }),
  );
  assert.ok(
    Number.isSafeInteger(issue.number) &&
      typeof issue.node_id === 'string' &&
      testResourceObject(issue.user).node_id === account.nodeId &&
      String(issue.body).includes(resource.marker),
    'test-resource-issue-response-invalid',
  );
  Object.assign(resource, { number: issue.number, nodeId: issue.node_id });
  receipt.sequence++;
  await input.checkpoint(receipt);
  return issue;
}
