import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { gunzipSync, gzipSync } from 'node:zlib';

import { extract, pack, type Header } from 'tar-stream';

export const clawHubSourceMaps = [
  'dist/index.js.map',
  'dist/memory-secret-provider-entry.js.map',
  'dist/codex/codex-runtime.js.map',
];

export function withoutClawHubSourceMapReference(path: string, contents: Buffer): Buffer {
  if (!clawHubSourceMaps.includes(`${path}.map`)) return contents;
  return Buffer.from(
    contents
      .toString('utf8')
      .replace(
        new RegExp(
          `^//# sourceMappingURL=${basename(path).replaceAll('.', '\\.')}\\.map\\r?$(?:\\n)?`,
          'gm',
        ),
        '',
      ),
  );
}

export async function clawHubFallback(archive: Buffer) {
  const entries: Array<{ header: Header; contents: Buffer }> = [];
  const unpack = extract();
  const extracted = new Promise<void>((resolve, reject) => {
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
  await extracted;

  const removed = clawHubSourceMaps.map((path) => `package/${path}`);
  for (const path of removed) {
    const matches = entries.filter(({ header }) => header.name === path);
    assert.equal(matches.length, 1, `expected one external source map: ${path}`);
    assert.equal(matches[0]!.header.type, 'file');
  }

  const output = pack();
  const packed = buffer(output);
  let unpackedBytes = 0;
  for (const { header, contents } of entries) {
    if (removed.includes(header.name)) continue;
    const retained = withoutClawHubSourceMapReference(
      header.name.replace(/^package\//u, ''),
      contents,
    );
    unpackedBytes += retained.length;
    output.entry({ ...header, size: retained.length }, retained);
  }
  output.finalize();
  const fallback = gzipSync(await packed);
  return {
    archive: fallback,
    removed,
    originalCompressedBytes: archive.length,
    originalUnpackedBytes: entries.reduce((sum, entry) => sum + entry.contents.length, 0),
    compressedBytes: fallback.length,
    unpackedBytes,
  };
}
