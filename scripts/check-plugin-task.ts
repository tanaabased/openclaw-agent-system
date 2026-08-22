import { readFile } from 'node:fs/promises';

import pluginMetadataFailures, {
  type PackageMetadata,
  type PluginManifest,
} from '../core/plugin-metadata-failures.ts';

const [packageContents, manifestContents, nodeVersionContents] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile('openclaw.plugin.json', 'utf8'),
  readFile('.node-version', 'utf8'),
]);
const packageMetadata = JSON.parse(packageContents) as PackageMetadata;
const manifest = JSON.parse(manifestContents) as PluginManifest;
const failures = pluginMetadataFailures(packageMetadata, manifest).map(({ message }) => message);

const nodeVersion = nodeVersionContents.trim();
const nodeRange = packageMetadata.engines?.node;
if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
  failures.push('.node-version must contain an exact semantic version');
} else if (!nodeRange) {
  failures.push('package.json must declare engines.node');
} else if (!Bun.semver.satisfies(nodeVersion, nodeRange)) {
  failures.push(`Node ${nodeVersion} does not satisfy package engines ${nodeRange}`);
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`plugin check: ${failure}\n`);
  process.exit(1);
}

process.stdout.write('plugin check: ok\n');
