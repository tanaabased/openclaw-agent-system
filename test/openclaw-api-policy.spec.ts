import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sourceRoots = [
  'agent',
  'api',
  'channels',
  'cli',
  'core',
  'credentials',
  'environment',
  'manifest',
  'paths',
  'scripts',
  'tools',
  'utils',
];
const protectedRuntimeMembers = [
  'runtime.gateway.request',
  'runtime.state.openChannelIngressQueue',
  'runtime.state.openKeyedStore',
  'runtime.state.openSyncKeyedStore',
] as const;

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
      for (const member of protectedRuntimeMembers) {
        assert.equal(
          source.includes(member),
          false,
          `${file} must not call the protected ${member} surface`,
        );
      }
      assert.equal(
        /from ['"]openclaw\/(?:dist|src)\//u.test(source),
        false,
        `${file} must not import private openclaw implementation modules`,
      );
    }
  });
});
