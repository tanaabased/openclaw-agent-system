import { isDeepStrictEqual } from 'node:util';

import { githubNotificationChannelMetadata } from '../channels/github/metadata.ts';
import { agentSystemPluginIdentity } from './plugin-identity.ts';

export interface PackageMetadata {
  description?: string;
  devDependencies?: {
    '@types/node'?: string;
    openclaw?: string;
  };
  engines?: {
    node?: string;
  };
  files?: string[];
  name?: string;
  openclaw?: {
    channel?: Record<string, unknown>;
    build?: {
      openclawVersion?: string;
      pluginSdkVersion?: string;
    };
    compat?: {
      minGatewayVersion?: string;
      pluginApi?: string;
    };
    extensions?: string[];
    runtimeExtensions?: string[];
  };
  os?: string[];
  peerDependencies?: {
    openclaw?: string;
  };
  version?: string;
}

export interface PluginManifest {
  activation?: {
    onCommands?: string[];
    onStartup?: boolean;
  };
  commandAliases?: Array<{
    cliCommand?: string;
    name?: string;
  }>;
  cliCommands?: Array<{
    description?: string;
    hasSubcommands?: boolean;
    name?: string;
  }>;
  channelConfigs?: Record<string, { schema?: Record<string, unknown> }>;
  channels?: string[];
  contracts?: {
    tools?: string[];
    trustedToolPolicies?: string[];
  };
  configSchema?: {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    type?: string;
  };
  description?: string;
  id?: string;
  name?: string;
  skills?: string[];
  version?: string;
}

export type PluginMetadataFailureCode =
  | 'package-name'
  | 'supported-os'
  | 'plugin-id'
  | 'plugin-name'
  | 'plugin-description'
  | 'version-mismatch'
  | 'source-entry'
  | 'runtime-entry'
  | 'startup-activation'
  | 'canonical-command'
  | 'alias-command'
  | 'canonical-command-alias'
  | 'short-command-alias'
  | 'cli-command-contract'
  | 'channel-contract'
  | 'channel-config-contract'
  | 'channel-metadata-contract'
  | 'tool-contract'
  | 'tool-policy-contract'
  | 'skill-contract'
  | 'config-schema-type'
  | 'config-schema-strictness'
  | 'package-file'
  | 'development-openclaw-version'
  | 'peer-openclaw-version'
  | 'plugin-api-version'
  | 'gateway-version'
  | 'build-openclaw-version'
  | 'build-sdk-version';

export interface PluginMetadataFailure {
  code: PluginMetadataFailureCode;
  message: string;
}

const supportedOperatingSystems = ['darwin', 'linux'];
const githubNotificationChannelId = 'agent-system-github';
const cliCommands = [
  {
    name: 'agent-system',
    description: 'Manage reproducible OpenClaw agent workspaces.',
    hasSubcommands: true,
  },
  {
    name: 'as',
    description: 'Alias for the Agent System command.',
    hasSubcommands: true,
  },
];
const githubNotificationChannelConfigs = {
  [githubNotificationChannelId]: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accounts: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: {
                type: 'boolean',
              },
            },
            required: ['enabled'],
          },
        },
      },
      required: ['accounts'],
    },
  },
};
const requiredPackageFiles = [
  'dist/',
  'index.ts',
  'agent/',
  'api/',
  'bin/',
  'channels/',
  'cli/',
  'core/',
  'credentials/',
  'environment/',
  'manifest/',
  'paths/',
  'skills/',
  'tools/',
  'utils/',
  'assets/',
  'openclaw.plugin.json',
  'README.md',
  'API.md',
  'ADVANCED.md',
  'DEVELOPMENT.md',
  'CHANGELOG.md',
  'LICENSE',
];
const exactSemanticVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function containsExactly(actual: string[] | undefined, expected: string[]): boolean {
  return actual?.length === expected.length && expected.every((value) => actual.includes(value));
}

function declaresCommandAlias(
  aliases: PluginManifest['commandAliases'],
  name: string,
  cliCommand: string,
): boolean {
  return aliases?.some((alias) => alias.name === name && alias.cliCommand === cliCommand) === true;
}

export default function pluginMetadataFailures(
  packageMetadata: PackageMetadata,
  manifest: PluginManifest,
): PluginMetadataFailure[] {
  const failures: PluginMetadataFailure[] = [];
  const check = (condition: boolean, code: PluginMetadataFailureCode, message: string): void => {
    if (!condition) failures.push({ code, message });
  };
  const developmentOpenClawVersion = packageMetadata.devDependencies?.openclaw;
  const hasExactDevelopmentOpenClawVersion =
    typeof developmentOpenClawVersion === 'string' &&
    exactSemanticVersion.test(developmentOpenClawVersion);
  const minimumGatewayVersion = packageMetadata.openclaw?.compat?.minGatewayVersion;
  const hasExactMinimumGatewayVersion =
    typeof minimumGatewayVersion === 'string' && exactSemanticVersion.test(minimumGatewayVersion);
  const expectedCompatibilityRange = hasExactMinimumGatewayVersion
    ? `>=${minimumGatewayVersion}`
    : undefined;

  check(
    manifest.activation?.onStartup === true,
    'startup-activation',
    'plugin must activate at Gateway startup',
  );
  check(
    packageMetadata.name === '@tanaab/openclaw-agent-system',
    'package-name',
    'unexpected npm package name',
  );
  check(
    containsExactly(packageMetadata.os, supportedOperatingSystems),
    'supported-os',
    'npm package must support exactly macOS and Linux',
  );
  check(manifest.id === agentSystemPluginIdentity.id, 'plugin-id', 'unexpected OpenClaw plugin id');
  check(
    manifest.name === agentSystemPluginIdentity.name,
    'plugin-name',
    'unexpected OpenClaw plugin name',
  );
  check(
    packageMetadata.description === agentSystemPluginIdentity.description &&
      manifest.description === agentSystemPluginIdentity.description,
    'plugin-description',
    'package, manifest, and runtime descriptions must match',
  );
  check(
    typeof packageMetadata.version === 'string' &&
      packageMetadata.version.length > 0 &&
      packageMetadata.version === manifest.version,
    'version-mismatch',
    'package and manifest versions differ',
  );
  check(
    packageMetadata.openclaw?.extensions?.includes('./index.ts') === true,
    'source-entry',
    'source entry missing',
  );
  check(
    packageMetadata.openclaw?.runtimeExtensions?.includes('./dist/index.js') === true,
    'runtime-entry',
    'runtime entry missing',
  );
  check(
    manifest.activation?.onCommands?.includes('agent-system') === true,
    'canonical-command',
    'plugin must activate for agent-system',
  );
  check(
    manifest.activation?.onCommands?.includes('as') === true,
    'alias-command',
    'plugin must activate for as',
  );
  check(
    declaresCommandAlias(manifest.commandAliases, 'agent-system', 'agent-system'),
    'canonical-command-alias',
    'canonical command alias is missing',
  );
  check(
    declaresCommandAlias(manifest.commandAliases, 'as', 'as'),
    'short-command-alias',
    'short command alias is missing',
  );
  check(
    isDeepStrictEqual(manifest.cliCommands, cliCommands),
    'cli-command-contract',
    'plugin must declare exact root CLI metadata without loading its runtime',
  );
  check(
    containsExactly(manifest.channels, [githubNotificationChannelId]),
    'channel-contract',
    'plugin must declare exactly the registered Agent System channels',
  );
  check(
    isDeepStrictEqual(manifest.channelConfigs, githubNotificationChannelConfigs),
    'channel-config-contract',
    'plugin must declare the exact Agent System channel configuration schema',
  );
  check(
    isDeepStrictEqual(packageMetadata.openclaw?.channel, githubNotificationChannelMetadata),
    'channel-metadata-contract',
    'package must publish exact GitHub notification channel metadata',
  );
  check(
    containsExactly(manifest.contracts?.tools, [
      'agent_system_git',
      'agent_system_git_worktree',
      'agent_system_github',
      'agent_system_github_reply',
    ]),
    'tool-contract',
    'plugin must declare exactly the registered Agent System tools',
  );
  check(
    containsExactly(manifest.contracts?.trustedToolPolicies, [
      'agent-system.git',
      'agent-system.git-worktree',
      'agent-system.github',
    ]),
    'tool-policy-contract',
    'plugin must declare exactly the registered Agent System tool policies',
  );
  check(
    containsExactly(manifest.skills, ['./skills']),
    'skill-contract',
    'plugin must load its packaged skill directory',
  );
  check(
    manifest.configSchema?.type === 'object',
    'config-schema-type',
    'config schema must describe an object',
  );
  check(
    manifest.configSchema?.additionalProperties === false,
    'config-schema-strictness',
    'config schema must be strict',
  );

  for (const path of requiredPackageFiles) {
    check(
      packageMetadata.files?.includes(path) === true,
      'package-file',
      `package files must include ${path}`,
    );
  }

  check(
    hasExactDevelopmentOpenClawVersion,
    'development-openclaw-version',
    'development OpenClaw version must be pinned to an exact semantic version',
  );
  check(
    hasExactMinimumGatewayVersion &&
      packageMetadata.peerDependencies?.openclaw === expectedCompatibilityRange,
    'peer-openclaw-version',
    'OpenClaw peer dependency must use the minimum Gateway version as its compatibility floor',
  );
  check(
    hasExactMinimumGatewayVersion &&
      packageMetadata.openclaw?.compat?.pluginApi === expectedCompatibilityRange,
    'plugin-api-version',
    'plugin API compatibility must use the minimum Gateway version as its compatibility floor',
  );
  check(
    hasExactMinimumGatewayVersion,
    'gateway-version',
    'minimum Gateway version must be pinned to an exact semantic version',
  );
  check(
    hasExactDevelopmentOpenClawVersion &&
      packageMetadata.openclaw?.build?.openclawVersion === developmentOpenClawVersion,
    'build-openclaw-version',
    'build metadata must pin the development OpenClaw version',
  );
  check(
    hasExactDevelopmentOpenClawVersion &&
      packageMetadata.openclaw?.build?.pluginSdkVersion === developmentOpenClawVersion,
    'build-sdk-version',
    'build metadata must pin the development plugin SDK version',
  );

  return failures;
}
