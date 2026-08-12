import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sourceRoots = ['channels', 'cli', 'lib', 'scripts', 'tools', 'utils'];

async function typescriptFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) return typescriptFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

describe('openclaw api policy', () => {
  it('should keep runtime code on public plugin sdk surfaces', async () => {
    const files = [
      'index.ts',
      ...(await Promise.all(sourceRoots.map((path) => typescriptFiles(path)))).flat(),
    ];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      assert.equal(
        source.includes('runtime.gateway.request'),
        false,
        `${file} must not call the protected gateway request surface`,
      );
      assert.equal(
        /from ['"]openclaw\/(?:dist|src)\//u.test(source),
        false,
        `${file} must not import private openclaw implementation modules`,
      );
    }
  });
});
