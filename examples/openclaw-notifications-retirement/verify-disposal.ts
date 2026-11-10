import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const [root, beforePath] = process.argv.slice(2) as [string, string];
const before = JSON.parse(await readFile(beforePath, 'utf8'));
assert.match(before.id, /^[a-f0-9]{64}$/u);
for (const name of await readdir(root)) {
  if (/^openclaw-dispatch-[a-f0-9]{64}\.json$/u.test(name)) {
    const state = JSON.parse(await readFile(join(root, name), 'utf8'));
    assert.ok(state.records.every((record: { id: string }) => record.id !== before.id));
  }
  if (/^history-openclaw-[a-f0-9]{64}$/u.test(name)) {
    for (const file of await readdir(join(root, name))) {
      if (!/^\d+-[a-f0-9]{64}\.json$/u.test(file)) continue;
      const snapshot = JSON.parse(await readFile(join(root, name, file), 'utf8'));
      assert.notEqual(snapshot.value?.id, before.id);
    }
  }
}
