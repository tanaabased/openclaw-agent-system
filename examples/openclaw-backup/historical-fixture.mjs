import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';

import { extract, pack } from 'tar-stream';

// only disposable archives derived from this scenario's public create result are written.
const created = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(created.status, 'created');
const parser = extract();
const entries = [];
parser.end(gunzipSync(await readFile(created.archive)));
for await (const entry of parser) {
  const chunks = [];
  for await (const chunk of entry) chunks.push(chunk);
  entries.push({ header: entry.header, bytes: Buffer.concat(chunks) });
}
const source = JSON.parse(entries[0].bytes.toString('utf8'));
assert.equal(source.agentId, 'backup-tanaabot');
assert.equal(source.coverage.openclawState, 'captured');
const databasePath = join(process.env.TMPDIR, 'prune-historical.sqlite');
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA user_version = 24;
  CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER, agent_id TEXT);
`);
database
  .prepare('INSERT INTO schema_meta VALUES (?, ?, ?, ?)')
  .run('primary', 'agent', 24, source.agentId);
database.close();
const bytes = await readFile(databasePath);
for (const year of [2000, 2001]) {
  const capturedAt = `${year}-01-01T00:00:00.000Z`;
  const snapshot = {
    schemaVersion: 1,
    snapshotId: `historical-${year}`,
    createdAt: capturedAt,
    database: {
      role: 'agent',
      agentId: source.agentId,
      basename: 'openclaw-agent.sqlite',
      userVersion: 24,
    },
    artifact: {
      path: 'database.sqlite',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    },
  };
  const manifest = {
    ...source,
    capturedAt,
    settings: { ...source.settings, openclawState: 'required' },
    coverage: {
      ...source.coverage,
      stage: 'workspace-and-agent-state',
      openclawState: 'captured',
    },
    snapshot: { manifest: snapshot, openclawVersion: 'fixture', agentSystemVersion: 'fixture' },
  };
  const stream = pack();
  const collecting = (async () => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  stream.entry({ name: 'manifest.json', type: 'file', mode: 0o600 }, JSON.stringify(manifest));
  for (const entry of entries.slice(1)) {
    if (!entry.header.name.startsWith('openclaw-state/')) {
      stream.entry(entry.header, entry.bytes);
    }
  }
  stream.entry({ name: 'openclaw-state/', type: 'directory', mode: 0o700 });
  stream.entry(
    { name: 'openclaw-state/manifest.json', type: 'file', mode: 0o600 },
    JSON.stringify(snapshot),
  );
  stream.entry({ name: 'openclaw-state/database.sqlite', type: 'file', mode: 0o600 }, bytes);
  stream.finalize();
  await writeFile(
    join(dirname(created.archive), `historical-${year}.tar.gz`),
    gzipSync(await collecting),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
}
