import { readFile } from 'node:fs/promises';

import pluginMetadataFailures, {
  type PackageMetadata,
  type PluginManifest,
} from '../core/plugin-metadata-failures.ts';
import nodeTypesBaselineFailure from './node-types-baseline.ts';

const [packageContents, manifestContents, nodeVersionContents, installedOpenClawContents] =
  await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('openclaw.plugin.json', 'utf8'),
    readFile('.node-version', 'utf8'),
    readFile('node_modules/openclaw/package.json', 'utf8'),
  ]);
const packageMetadata = JSON.parse(packageContents) as PackageMetadata;
const manifest = JSON.parse(manifestContents) as PluginManifest;
const installedOpenClaw = JSON.parse(installedOpenClawContents) as { version?: string };
const failures = pluginMetadataFailures(packageMetadata, manifest).map(({ message }) => message);
const testVersion = process.env.OPENCLAW_COMPATIBILITY_TEST_VERSION;
const expectedVersion = testVersion ?? packageMetadata.devDependencies?.openclaw;
const actualVersion = installedOpenClaw.version ?? 'unknown';
const targetKind = testVersion ? 'compatibility test' : 'development';
const pluginApiRange = packageMetadata.openclaw?.compat?.pluginApi ?? '';
const peerRange = packageMetadata.peerDependencies?.openclaw ?? '';
const expectedDisplay = expectedVersion ?? 'unknown';
const pluginApiDisplay = pluginApiRange || 'unknown';

if (installedOpenClaw.version !== expectedVersion) {
  failures.push(
    `installed OpenClaw ${actualVersion} must match ${targetKind} target ${expectedDisplay}`,
  );
}

if (testVersion && !Bun.semver.satisfies(testVersion, pluginApiRange)) {
  failures.push(
    `compatibility target ${testVersion} must satisfy plugin API range ${pluginApiDisplay}`,
  );
}

if (testVersion && !Bun.semver.satisfies(testVersion, peerRange)) {
  failures.push(
    `compatibility target ${testVersion} must satisfy peer range ${peerRange || 'unknown'}`,
  );
}

const nodeVersion = nodeVersionContents.trim();
const nodeRange = packageMetadata.engines?.node;
if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) {
  failures.push('.node-version must contain an exact semantic version');
} else if (!nodeRange) {
  failures.push('package.json must declare engines.node');
} else if (!Bun.semver.satisfies(nodeVersion, nodeRange)) {
  failures.push(`Node ${nodeVersion} does not satisfy package engines ${nodeRange}`);
}

const nodeTypesFailure = nodeTypesBaselineFailure(
  nodeVersion,
  packageMetadata.devDependencies?.['@types/node'],
);
if (nodeTypesFailure) failures.push(nodeTypesFailure);

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`plugin check: ${failure}\n`);
  process.exit(1);
}

process.stdout.write('plugin check: ok\n');
