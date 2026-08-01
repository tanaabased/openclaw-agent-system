import { readFile } from 'node:fs/promises';

interface PackageMetadata {
  name?: string;
  version?: string;
  engines?: {
    node?: string;
  };
  files?: string[];
  openclaw?: {
    extensions?: string[];
    runtimeExtensions?: string[];
    compat?: {
      pluginApi?: string;
      minGatewayVersion?: string;
    };
    build?: {
      openclawVersion?: string;
      pluginSdkVersion?: string;
    };
  };
}

interface PluginManifest {
  id?: string;
  name?: string;
  version?: string;
  activation?: {
    onCommands?: string[];
  };
  configSchema?: {
    additionalProperties?: boolean;
  };
}

const EXPECTED_OPENCLAW_VERSION = '2026.7.1-2';
const failures: string[] = [];
const [packageContents, manifestContents, nodeVersionContents] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile('openclaw.plugin.json', 'utf8'),
  readFile('.node-version', 'utf8'),
]);
const packageMetadata = JSON.parse(packageContents) as PackageMetadata;
const manifest = JSON.parse(manifestContents) as PluginManifest;

function requireEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) failures.push(message);
}

function requireIncludes(values: string[] | undefined, expected: string, message: string): void {
  if (!values?.includes(expected)) failures.push(message);
}

requireEqual(
  packageMetadata.name,
  '@tanaab/openclaw-agent-system',
  'package name must be @tanaab/openclaw-agent-system',
);
requireEqual(manifest.id, 'agent-system', 'plugin id must be agent-system');
requireEqual(manifest.name, 'Agent System', 'plugin display name must be Agent System');
requireEqual(
  packageMetadata.version,
  manifest.version,
  'package and plugin manifest versions must match',
);
requireEqual(
  manifest.configSchema?.additionalProperties,
  false,
  'plugin config schema must reject unknown keys',
);
requireIncludes(
  manifest.activation?.onCommands,
  'agent-system',
  'plugin manifest must activate for agent-system',
);
requireIncludes(manifest.activation?.onCommands, 'as', 'plugin manifest must activate for as');
requireIncludes(
  packageMetadata.openclaw?.extensions,
  './index.ts',
  'package must declare the TypeScript plugin entry',
);
requireIncludes(
  packageMetadata.openclaw?.runtimeExtensions,
  './dist/index.js',
  'package must declare the built plugin entry',
);
requireEqual(
  packageMetadata.openclaw?.compat?.pluginApi,
  `>=${EXPECTED_OPENCLAW_VERSION}`,
  'plugin API compatibility must match the development SDK',
);
requireEqual(
  packageMetadata.openclaw?.compat?.minGatewayVersion,
  EXPECTED_OPENCLAW_VERSION,
  'minimum Gateway version must match the development SDK',
);
requireEqual(
  packageMetadata.openclaw?.build?.openclawVersion,
  EXPECTED_OPENCLAW_VERSION,
  'build metadata must pin the development OpenClaw version',
);
requireEqual(
  packageMetadata.openclaw?.build?.pluginSdkVersion,
  EXPECTED_OPENCLAW_VERSION,
  'build metadata must pin the development plugin SDK version',
);

for (const path of [
  'dist/',
  'index.ts',
  'lib/',
  'utils/',
  'assets/agent-system.png',
  'openclaw.plugin.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
]) {
  requireIncludes(packageMetadata.files, path, `package files must include ${path}`);
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

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`plugin check: ${failure}\n`);
  process.exit(1);
}

process.stdout.write('plugin check: ok\n');
