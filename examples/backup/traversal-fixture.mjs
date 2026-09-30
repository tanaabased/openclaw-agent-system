import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { pack } from 'tar-stream';

const [manifestPath, archivePath] = process.argv.slice(2);
if (!manifestPath || !archivePath) throw new Error('Provide manifest and archive paths.');

const stream = pack();
const writing = pipeline(stream, createGzip(), createWriteStream(archivePath, { mode: 0o600 }));
stream.entry({ name: 'manifest.json', type: 'file' }, await readFile(manifestPath));
stream.entry({ name: 'workspace/', type: 'directory' });
stream.entry({ name: 'workspace/../escape', type: 'file' }, 'outside recovery\n');
stream.finalize();
await writing;
