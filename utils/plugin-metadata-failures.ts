export interface PackageMetadata {
  devDependencies?: {
    openclaw?: string;
  };
  engines?: {
    node?: string;
  };
  files?: string[];
  name?: string;
  openclaw?: {
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
  configSchema?: {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    type?: string;
  };
  id?: string;
  name?: string;
  version?: string;
}

export type PluginMetadataFailureCode =
  | 'package-name'
  | 'supported-os'
  | 'plugin-id'
  | 'plugin-name'
  | 'version-mismatch'
  | 'source-entry'
  | 'runtime-entry'
  | 'startup-activation'
  | 'canonical-command'
  | 'alias-command'
  | 'canonical-command-alias'
  | 'short-command-alias'
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
const requiredPackageFiles = [
  'dist/',
  'index.ts',
  'cli/',
  'bin/',
  'lib/',
  'utils/',
  'assets/agent-system.png',
  'openclaw.plugin.json',
  'README.md',
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
  check(manifest.id === 'agent-system', 'plugin-id', 'unexpected OpenClaw plugin id');
  check(manifest.name === 'Agent System', 'plugin-name', 'unexpected OpenClaw plugin name');
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
    hasExactDevelopmentOpenClawVersion &&
      packageMetadata.peerDependencies?.openclaw === `>=${developmentOpenClawVersion}`,
    'peer-openclaw-version',
    'OpenClaw peer dependency must match the development SDK',
  );
  check(
    hasExactDevelopmentOpenClawVersion &&
      packageMetadata.openclaw?.compat?.pluginApi === `>=${developmentOpenClawVersion}`,
    'plugin-api-version',
    'plugin API compatibility must match the development SDK',
  );
  check(
    hasExactDevelopmentOpenClawVersion &&
      packageMetadata.openclaw?.compat?.minGatewayVersion === developmentOpenClawVersion,
    'gateway-version',
    'minimum Gateway version must match the development SDK',
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
