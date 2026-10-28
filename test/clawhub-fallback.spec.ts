import assert from 'node:assert/strict';
import { buffer } from 'node:stream/consumers';
import { gunzipSync, gzipSync } from 'node:zlib';

import { extract, pack, type Header } from 'tar-stream';

import { clawHubFallback } from '../scripts/clawhub-fallback.ts';

type Entry = { header: Partial<Header> & { name: string }; contents: Buffer };

async function archive(entries: Entry[]) {
  const output = pack();
  const result = buffer(output);
  for (const { header, contents } of entries) output.entry(header, contents);
  output.finalize();
  return gzipSync(await result);
}

async function readArchive(archive: Buffer) {
  const unpack = extract();
  const entries: Entry[] = [];
  const done = new Promise<void>((resolve, reject) => {
    unpack.on('error', reject);
    unpack.on('finish', resolve);
    unpack.on('entry', (header, stream, next) => {
      void buffer(stream).then((contents) => {
        entries.push({ header, contents });
        next();
      }, reject);
    });
  });
  unpack.end(gunzipSync(archive));
  await done;
  return entries;
}

function fixture() {
  const files: Record<string, string | Buffer> = {
    'package.json': '{"name":"@tanaab/test","version":"9.9.9","dependencies":{"example":"1"}}',
    'openclaw.plugin.json': '{"id":"test","version":"9.9.9"}',
    'skills/example/SKILL.md': 'retained skill',
    'assets/icon.png': Buffer.from([0, 255, 128, 10]),
    'dist/unrelated.map': 'not a runtime source map',
    'dist/index.js': 'export const value = 1;\n//# sourceMappingURL=index.js.map\n',
    'dist/memory-secret-provider-entry.js': 'export default "unchanged";\n',
    'dist/codex/codex-runtime.js':
      '#!/usr/bin/env node\nprocess.stdout.write("ok");\n//# sourceMappingURL=codex-runtime.js.map\r\n',
    'dist/index.js.map': '{"sources":[]}',
    'dist/memory-secret-provider-entry.js.map': '{"sources":[]}',
    'dist/codex/codex-runtime.js.map': '{"sources":[]}',
  };
  return Object.entries(files).map(([name, contents]) => ({
    header: { name: `package/${name}`, type: 'file' as const, mode: 0o755 },
    contents: Buffer.from(contents),
  }));
}

describe('scripts/clawhub-fallback', () => {
  it('should remove only runtime maps and their references while preserving package bytes and modes', async () => {
    const entries = fixture();
    const original = await archive(entries);
    const preserved = Buffer.from(original);
    const result = await clawHubFallback(original);
    const retained = await readArchive(result.archive);
    assert.deepEqual(original, preserved);
    assert.equal(retained.length, entries.length - 3);
    const removed = new Set([
      'package/dist/index.js.map',
      'package/dist/memory-secret-provider-entry.js.map',
      'package/dist/codex/codex-runtime.js.map',
    ]);
    assert.deepEqual(
      new Set(retained.map(({ header }) => header.name)),
      new Set(entries.map(({ header }) => header.name).filter((name) => !removed.has(name))),
    );
    for (const { header, contents } of retained) {
      const before = entries.find((entry) => entry.header.name === header.name)!;
      assert.equal(header.mode, before.header.mode);
      if (header.name === 'package/dist/index.js') {
        assert.equal(contents.toString(), 'export const value = 1;\n');
      } else if (header.name === 'package/dist/codex/codex-runtime.js') {
        assert.equal(contents.toString(), '#!/usr/bin/env node\nprocess.stdout.write("ok");\n');
      } else {
        assert.deepEqual(contents, before.contents, header.name);
      }
    }
    assert.equal(result.removed.length, 3);
    assert.equal(result.compressedBytes, result.archive.length);
    assert.equal(result.originalCompressedBytes, original.length);
    assert.equal(
      result.originalUnpackedBytes,
      entries.reduce((sum, entry) => sum + entry.contents.length, 0),
    );
    assert.equal(
      result.unpackedBytes,
      retained.reduce((sum, entry) => sum + entry.contents.length, 0),
    );
    assert.ok(result.unpackedBytes < result.originalUnpackedBytes);
  });

  it('should reject an unexpected or already stripped archive', async () => {
    await assert.rejects(
      clawHubFallback(
        await archive(fixture().filter(({ header }) => !header.name.endsWith('index.js.map'))),
      ),
      /expected one external source map/,
    );
    await assert.rejects(clawHubFallback(Buffer.from('not gzip')));
  });
});
