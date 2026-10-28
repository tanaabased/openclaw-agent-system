import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { clawHubFallback } from './clawhub-fallback.ts';

const [input, output] = process.argv.slice(2);
assert.ok(input && output, 'expected input and output tarball paths');
assert.notEqual(resolve(input), resolve(output), 'fallback must not replace the original archive');
const { archive, ...report } = await clawHubFallback(await readFile(input));
await writeFile(output, archive, { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ tarball: resolve(output), ...report }, null, 2)}\n`);
