import AgentSystemToolError from '../../api/error.ts';
import type { AgentSystemManifestValueResolver } from '../../api/types.ts';
import type { ResolvableString } from '../../manifest/value-types.ts';
import type { GitToolConfiguration } from './config-schema.ts';

export interface ResolvedGitIdentity {
  email: string;
  name: string;
}

export type GitConfigurationEntry = readonly [key: string, value: string];

function resolveIdentityValue(
  value: ResolvableString | undefined,
  fieldPath: string,
  resolver: AgentSystemManifestValueResolver,
): string {
  if (value === undefined) {
    throw new AgentSystemToolError(
      'configuration_unavailable',
      `The Git identity value ${fieldPath} is not configured.`,
    );
  }
  try {
    return resolver.resolve(value, fieldPath);
  } catch {
    throw new AgentSystemToolError(
      'configuration_unavailable',
      `The Git identity value ${fieldPath} is unavailable.`,
    );
  }
}

/** Resolve Git-specific identity first, then fall back to the agent declaration. */
export function resolveGitIdentity(
  configuration: GitToolConfiguration,
  resolver: AgentSystemManifestValueResolver,
): ResolvedGitIdentity {
  return {
    email: resolveIdentityValue(
      configuration.git.email ?? configuration.agent.email,
      configuration.git.email === undefined ? '/agent/email' : '/git/email',
      resolver,
    ),
    name: resolveIdentityValue(
      configuration.git.name ?? configuration.agent.name,
      configuration.git.name === undefined ? '/agent/name' : '/git/name',
      resolver,
    ),
  };
}

/** Build the fixed child-only Git identity and security configuration entries. */
export function gitIdentityConfiguration(
  identity: ResolvedGitIdentity,
  platform: NodeJS.Platform = process.platform,
  externalExtensions: readonly string[] = [],
): GitConfigurationEntry[] {
  const nullPath = platform === 'win32' ? 'NUL' : '/dev/null';
  return [
    ['user.name', identity.name],
    ['user.email', identity.email],
    ['user.useConfigOnly', 'true'],
    ['core.hooksPath', nullPath],
    ['credential.helper', ''],
    ...externalExtensions.map((extension) => [`alias.${extension}`, ''] as const),
  ];
}

/** Encode ordered command-scoped Git configuration without mutating a config file. */
export function gitConfigurationEnvironment(
  configuration: readonly GitConfigurationEntry[],
): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_CONFIG_COUNT: String(configuration.length),
  };
  configuration.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

/** Build a child-only Git identity and noninteractive configuration environment. */
export function gitIdentityEnvironment(
  identity: ResolvedGitIdentity,
  platform: NodeJS.Platform = process.platform,
  externalExtensions: readonly string[] = [],
  additionalConfiguration: readonly GitConfigurationEntry[] = [],
): Record<string, string> {
  const nullPath = platform === 'win32' ? 'NUL' : '/dev/null';
  const configuration = [
    ...gitIdentityConfiguration(identity, platform, externalExtensions),
    ...additionalConfiguration,
  ];
  const environment: Record<string, string> = {
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_NAME: identity.name,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_CONFIG_GLOBAL: nullPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
    PAGER: 'cat',
  };
  return { ...environment, ...gitConfigurationEnvironment(configuration) };
}
