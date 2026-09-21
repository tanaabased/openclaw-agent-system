import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

export const defaultMaximumCommentCharacters = 8_000;
export const maximumMaximumCommentCharacters = 64_000;

type AgentSystemPluginConfiguration = {
  githubNotifications?: {
    maxCommentCharacters?: unknown;
  };
};

export function validateMaximumCommentCharacters(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > maximumMaximumCommentCharacters
  ) {
    throw new Error(
      `GitHub notification maxCommentCharacters must be an integer from 1 to ${maximumMaximumCommentCharacters}.`,
    );
  }
  return Number(value);
}

/** Resolve the operator-wide comment intake boundary from live OpenClaw configuration. */
export function resolveMaximumCommentCharacters(config: OpenClawConfig): number {
  const pluginConfig = config.plugins?.entries?.['agent-system']?.config as
    | AgentSystemPluginConfiguration
    | undefined;
  const value = pluginConfig?.githubNotifications?.maxCommentCharacters;
  if (value === undefined) return defaultMaximumCommentCharacters;
  return validateMaximumCommentCharacters(value);
}
