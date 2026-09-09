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
const compatibilityTestVersion = process.env.OPENCLAW_COMPATIBILITY_TEST_VERSION;
const expectedInstalledOpenClawVersion =
  compatibilityTestVersion ?? packageMetadata.devDependencies?.openclaw;

if (installedOpenClaw.version !== expectedInstalledOpenClawVersion) {
  failures.push(
    `installed OpenClaw ${installedOpenClaw.version ?? 'unknown'} must match ${compatibilityTestVersion ? 'compatibility test' : 'development'} target ${expectedInstalledOpenClawVersion ?? 'unknown'}`,
  );
}

if (
  compatibilityTestVersion &&
  !Bun.semver.satisfies(
    compatibilityTestVersion,
    packageMetadata.openclaw?.compat?.pluginApi ?? '',
  )
) {
  failures.push(
    `compatibility test target ${compatibilityTestVersion} must satisfy plugin API range ${packageMetadata.openclaw?.compat?.pluginApi ?? 'unknown'}`,
  );
}

if (
  compatibilityTestVersion &&
  !Bun.semver.satisfies(
    compatibilityTestVersion,
    packageMetadata.peerDependencies?.openclaw ?? '',
  )
) {
  failures.push(
    `compatibility test target ${compatibilityTestVersion} must satisfy peer range ${packageMetadata.peerDependencies?.openclaw ?? 'unknown'}`,
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
