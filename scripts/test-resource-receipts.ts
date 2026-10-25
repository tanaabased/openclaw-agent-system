import { isDeepStrictEqual } from 'node:util';

import { unzipSync } from 'fflate';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const testBucket = 'tanaabased/big-test-bucket';
export const testBucketId = 1329940218;
export const receiptLimit = 128 * 1024;
const text = Type.String({ minLength: 1, maxLength: 512 });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const uuid = Type.String({ pattern: '^[a-f0-9-]{36}$' });
const account = Type.Object(
  { login: Type.Union([Type.Literal('tanaabot'), Type.Literal('emoriwan')]), nodeId: text },
  { additionalProperties: false },
);
const source = Type.Object(
  {
    repository: text,
    repositoryId: positive,
    runId: positive,
    attempt: positive,
    workflow: text,
    jobName: text,
    scenario: Type.String({ pattern: '^[a-z0-9-]+$' }),
    os: Type.String({ pattern: '^[a-z0-9.-]+$' }),
    nonce: uuid,
  },
  { additionalProperties: false },
);
const key = Type.Object(
  {
    receiptId: text,
    kind: Type.Union([Type.Literal('authentication-key'), Type.Literal('signing-key')]),
    account,
    publicKey: Type.String({ minLength: 1, maxLength: 16_384 }),
    fingerprint: text,
    title: text,
    id: Type.Optional(positive),
  },
  { additionalProperties: false },
);
const issue = Type.Object(
  {
    receiptId: uuid,
    kind: Type.Literal('issue'),
    repository: Type.Literal(testBucket),
    account,
    marker: text,
    number: Type.Optional(positive),
    nodeId: Type.Optional(text),
  },
  { additionalProperties: false },
);
const pullRequest = Type.Object(
  {
    receiptId: text,
    kind: Type.Literal('pull-request'),
    repository: Type.Literal(testBucket),
    account,
    number: positive,
    nodeId: text,
    issueNodeId: text,
    branch: text,
    headSha: Type.String({ pattern: '^[a-f0-9]{40}$' }),
  },
  { additionalProperties: false },
);
const schema = Type.Object(
  {
    version: Type.Literal(1),
    source,
    sequence: Type.Integer({ minimum: 0, maximum: 31 }),
    finished: Type.Boolean(),
    problems: Type.Array(Type.String({ pattern: '^[a-z0-9-]+$', maxLength: 128 }), {
      maxItems: 32,
    }),
    resources: Type.Array(Type.Union([key, issue, pullRequest]), { maxItems: 32 }),
  },
  { additionalProperties: false },
);

export type TestResourceReceipt = Static<typeof schema>;
export type TestResourceSource = TestResourceReceipt['source'];
export type TestResource = TestResourceReceipt['resources'][number];
export type TestResourceAccount = TestResource['account'];

export function issueMarker(source: TestResourceSource, receiptId: string): string {
  return `<!-- agent-system-test:${source.repositoryId}:${source.runId}:${source.attempt}:${receiptId} -->`;
}

export function parseTestResourceReceipt(value: unknown): TestResourceReceipt {
  if (!Value.Check(schema, value)) throw new Error('test-resource-receipt-invalid');
  if (new Set(value.resources.map(({ receiptId }) => receiptId)).size !== value.resources.length)
    throw new Error('test-resource-receipt-duplicate');
  for (const resource of value.resources) {
    if (
      resource.kind === 'issue' &&
      (resource.marker !== issueMarker(value.source, resource.receiptId) ||
        Boolean(resource.number) !== Boolean(resource.nodeId))
    )
      throw new Error('test-resource-issue-receipt-invalid');
  }
  return value;
}

export function receiptArtifactName(receipt: TestResourceReceipt): string {
  const { runId, attempt, nonce } = receipt.source;
  return `test-resources-${runId}-${attempt}-${nonce}-${receipt.sequence}`;
}

export function readReceiptArchive(bytes: Uint8Array): TestResourceReceipt {
  if (bytes.length > receiptLimit) throw new Error('test-resource-archive-too-large');
  const names: string[] = [];
  const files = unzipSync(bytes, {
    filter(entry) {
      names.push(entry.name);
      if (entry.name !== 'receipt.json' || entry.originalSize > receiptLimit || names.length > 1)
        throw new Error('test-resource-archive-invalid');
      return true;
    },
  });
  const file = files['receipt.json'];
  if (!file || file.length > receiptLimit || names.length !== 1)
    throw new Error('test-resource-archive-invalid');
  return parseTestResourceReceipt(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file)),
  );
}

export function mergeReceiptCheckpoints(receipts: TestResourceReceipt[]): TestResourceReceipt[] {
  const groups = new Map<string, TestResourceReceipt[]>();
  for (const raw of receipts) {
    const receipt = parseTestResourceReceipt(raw);
    const group = groups.get(receipt.source.nonce) ?? [];
    group.push(receipt);
    groups.set(receipt.source.nonce, group);
  }
  return [...groups.values()].map((group) => {
    const ordered = [...group].sort((left, right) => left.sequence - right.sequence);
    const first = ordered[0]!;
    if (first.sequence !== 0) throw new Error('test-resource-initial-checkpoint-missing');
    for (const [index, current] of ordered.entries()) {
      if (!isDeepStrictEqual(first.source, current.source))
        throw new Error('test-resource-source-conflict');
      const previous = ordered[index - 1];
      if (!previous) continue;
      if (previous.finished && !current.finished)
        throw new Error('test-resource-checkpoint-conflict');
      if (previous.sequence === current.sequence && !isDeepStrictEqual(previous, current))
        throw new Error('test-resource-checkpoint-conflict');
      for (const retained of previous.resources) {
        const next = current.resources.find(({ receiptId }) => receiptId === retained.receiptId);
        if (
          !next ||
          Object.entries(retained).some(
            ([name, value]) => !isDeepStrictEqual(value, (next as Record<string, unknown>)[name]),
          )
        )
          throw new Error('test-resource-checkpoint-conflict');
      }
    }
    return ordered.at(-1)!;
  });
}
