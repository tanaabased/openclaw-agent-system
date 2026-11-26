import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** A Codex cache contains the bundle, with no npm install at runtime. Ship the SDK's
 * adjacent WASM and both Darwin keyring binaries even when the package is built on Linux. */
export default async function codexOpAssets(outdir: string) {
  await mkdir(outdir, { recursive: true });
  const core = require.resolve('@1password/sdk-core');
  await copyFile(core, join(outdir, 'op-sdk-core.cjs'));
  await copyFile(
    require.resolve('@1password/sdk-core/nodejs/core_bg.wasm'),
    join(outdir, 'core_bg.wasm'),
  );

  const cache = '.cache/codex-keyring';
  const lock = Bun.JSONC.parse(await Bun.file('bun.lock').text()) as {
    lockfileVersion: number;
    configVersion: number;
    packages: Record<string, unknown> & {
      '@napi-rs/keyring': [string, string, { optionalDependencies: Record<string, string> }];
    };
  };
  const packages: Record<string, unknown> = {};
  const dependencies: Record<string, string> = {};
  for (const arch of ['arm64', 'x64']) {
    const name = '@napi-rs/keyring-darwin-' + arch;
    packages[name] = lock.packages[name];
    dependencies[name] = lock.packages['@napi-rs/keyring'][2].optionalDependencies[name]!;
  }
  // Use the exact package and integrity entries from the repository lockfile.
  const manifest = { name: 'codex-keyring-assets', dependencies };
  await mkdir(cache, { recursive: true });
  await Bun.write(join(cache, 'package.json'), JSON.stringify(manifest));
  await Bun.write(
    join(cache, 'bun.lock'),
    JSON.stringify({
      lockfileVersion: lock.lockfileVersion,
      configVersion: lock.configVersion,
      workspaces: { '': manifest },
      packages,
    }),
  );
  const install = Bun.spawn(
    [
      process.execPath,
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--os=darwin',
      '--cpu=*',
    ],
    {
      cwd: cache,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  if ((await install.exited) !== 0)
    throw new Error('Unable to prepare locked macOS Keychain modules.');
  for (const name of Object.keys(dependencies)) {
    const binary = 'keyring.' + name.slice('@napi-rs/keyring-'.length) + '.node';
    await copyFile(join(cache, 'node_modules', name, binary), join(outdir, binary));
  }
}
