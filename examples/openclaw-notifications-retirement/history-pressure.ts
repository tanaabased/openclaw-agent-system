import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// only the quiesced, disposable ci journal is seeded; native retirement receipts stay exact.
const [operation, root, beforePath] = process.argv.slice(2) as [string, string, string];
const before = JSON.parse(await readFile(beforePath, 'utf8'));
const matches = [];
for (const name of await readdir(root)) {
  if (!/^openclaw-dispatch-[a-f0-9]{64}\.json$/u.test(name)) continue;
  const path = join(root, name);
  const state = JSON.parse(await readFile(path, 'utf8'));
  const record = state.records.find((entry: { id: string }) => entry.id === before.id);
  if (record) matches.push({ path, state, record });
}
assert.equal(matches.length, 1);
const { path, state, record } = matches[0]!;
assert.ok(record.retired && record.retirement.worktreeRemovedAt);
async function archived() {
  const reference = record.retainedHistory.entries.at(-1);
  const cold = join(
    root,
    'history-openclaw-' + state.scope,
    reference.at + '-' + reference.digest + '.json',
  );
  const text = await readFile(cold, 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), reference.digest);
  return { cold, value: JSON.parse(text).value };
}
if (operation === 'verify-result') {
  assert.equal(record.retainedHistory.terminal, true);
  assert.deepEqual((await archived()).value.result, before.result);
} else if (operation === 'seed') {
  const { value } = await archived();
  // Restore the exact pre-offload fixture with its verified cleanup, then model stale bookkeeping.
  Object.assign(record, value);
  delete record.retainedHistory;
  const turn = record.decisionTurn ?? record.assessmentTurn;
  assert.ok(turn.consumedByEventId);
  turn.status = 'consumed';
  delete turn.replyEventId;
  delete turn.executionModel;
  delete turn.failed;
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 2 * 1024 * 1024);
  await writeFile(beforePath + '.history-seed.json', JSON.stringify(record));
  await writeFile(path, JSON.stringify(state));
} else {
  assert.equal(record.retainedHistory.terminal, true);
  assert.equal(record.result, undefined);
  assert.equal(record.threadId, before.threadId);
  assert.equal(record.retirement.worktreeRemovedAt, before.retirement.worktreeRemovedAt);
  assert.equal(
    state.records.filter((entry: { issueKey: string }) => entry.issueKey === before.issueKey)
      .length,
    1,
  );
  assert.ok(
    record.retainedHistory.outcome.turns.some(
      (turn: { status: string }) => turn.status === 'consumed',
    ),
  );
  if (operation === 'verify-and-remove-cold-copy') {
    const { cold, value } = await archived();
    assert.deepEqual(value, JSON.parse(await readFile(beforePath + '.history-seed.json', 'utf8')));
    await unlink(cold);
  } else assert.equal(operation, 'verify-terminal');
}
