import assert from 'node:assert/strict';

import pluginMetadataFailures, {
  type PackageMetadata,
  type PluginManifest,
  type PluginMetadataFailureCode,
} from '../utils/plugin-metadata-failures.ts';

const openclawVersion = '2026.7.1-2';
const packageMetadata: PackageMetadata = {
  description: 'Better per-agent management for OpenClaw.',
  name: '@tanaab/openclaw-agent-system',
  os: ['darwin', 'linux'],
  version: 'test-version',
  files: [
    'dist/',
    'index.ts',
    'cli/',
    'bin/',
    'lib/',
    'skills/',
    'tools/',
    'utils/',
    'assets/agent-system.png',
    'openclaw.plugin.json',
    'README.md',
    'API.md',
    'ADVANCED.md',
    'DEVELOPMENT.md',
    'CHANGELOG.md',
    'LICENSE',
  ],
  openclaw: {
    extensions: ['./index.ts'],
    runtimeExtensions: ['./dist/index.js'],
    compat: {
      pluginApi: `>=${openclawVersion}`,
      minGatewayVersion: openclawVersion,
    },
    build: {
      openclawVersion,
      pluginSdkVersion: openclawVersion,
    },
  },
  peerDependencies: {
    openclaw: `>=${openclawVersion}`,
  },
  devDependencies: {
    openclaw: openclawVersion,
  },
};

const manifest: PluginManifest = {
  description: 'Better per-agent management for OpenClaw.',
  id: 'agent-system',
  name: 'Agent System',
  version: 'test-version',
  activation: {
    onStartup: true,
    onCommands: ['agent-system', 'as'],
  },
  commandAliases: [
    { name: 'agent-system', cliCommand: 'agent-system' },
    { name: 'as', cliCommand: 'as' },
  ],
  contracts: {
    tools: ['agent_system_git', 'agent_system_git_worktree', 'agent_system_github'],
    trustedToolPolicies: ['agent-system.git', 'agent-system.git-worktree', 'agent-system.github'],
  },
  skills: ['./skills'],
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
};

function failureCodes(
  actualPackageMetadata: PackageMetadata,
  actualManifest: PluginManifest,
): Set<PluginMetadataFailureCode> {
  return new Set(
    pluginMetadataFailures(actualPackageMetadata, actualManifest).map(({ code }) => code),
  );
}

describe('utils/plugin-metadata-failures', () => {
  it('should accept aligned package and plugin metadata', () => {
    assert.deepEqual(pluginMetadataFailures(packageMetadata, manifest), []);
  });

  it('should report every scaffold contract mismatch', () => {
    assert.deepEqual(
      failureCodes({}, {}),
      new Set([
        'package-name',
        'supported-os',
        'plugin-id',
        'plugin-name',
        'plugin-description',
        'version-mismatch',
        'source-entry',
        'runtime-entry',
        'startup-activation',
        'canonical-command',
        'alias-command',
        'canonical-command-alias',
        'short-command-alias',
        'tool-contract',
        'tool-policy-contract',
        'skill-contract',
        'config-schema-type',
        'config-schema-strictness',
        'package-file',
        'development-openclaw-version',
        'peer-openclaw-version',
        'plugin-api-version',
        'gateway-version',
        'build-openclaw-version',
        'build-sdk-version',
      ]),
    );
  });

  it('should report package and manifest description drift', () => {
    assert.deepEqual(
      pluginMetadataFailures(
        { ...packageMetadata, description: 'Package description.' },
        { ...manifest, description: 'Manifest description.' },
      ),
      [
        {
          code: 'plugin-description',
          message: 'package, manifest, and runtime descriptions must match',
        },
      ],
    );
  });

  it('should reject a package that advertises an unsupported host', () => {
    assert.deepEqual(
      pluginMetadataFailures({ ...packageMetadata, os: ['darwin', 'linux', 'win32'] }, manifest),
      [
        {
          code: 'supported-os',
          message: 'npm package must support exactly macOS and Linux',
        },
      ],
    );
  });

  it('should report required command and companion documentation package files', () => {
    assert.deepEqual(
      pluginMetadataFailures(
        {
          ...packageMetadata,
          files: packageMetadata.files?.filter(
            (path) =>
              !['cli/', 'skills/', 'API.md', 'ADVANCED.md', 'DEVELOPMENT.md'].includes(path),
          ),
        },
        manifest,
      ),
      [
        { code: 'package-file', message: 'package files must include cli/' },
        { code: 'package-file', message: 'package files must include skills/' },
        { code: 'package-file', message: 'package files must include API.md' },
        { code: 'package-file', message: 'package files must include ADVANCED.md' },
        { code: 'package-file', message: 'package files must include DEVELOPMENT.md' },
      ],
    );
  });

  it('should report command and openclaw version drift independently', () => {
    assert.deepEqual(
      failureCodes(
        {
          ...packageMetadata,
          devDependencies: { openclaw: '2026.8.0' },
        },
        {
          ...manifest,
          activation: { onStartup: true, onCommands: ['agent-system'] },
          commandAliases: [{ name: 'agent-system', cliCommand: 'agent-system' }],
        },
      ),
      new Set([
        'alias-command',
        'short-command-alias',
        'peer-openclaw-version',
        'plugin-api-version',
        'gateway-version',
        'build-openclaw-version',
        'build-sdk-version',
      ]),
    );
  });
});
