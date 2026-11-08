import type { AgentManifest } from '../../manifest/types.ts';
import { defaultGitHubCliConfiguration } from '../github/config-schema.ts';

export type GitProtocol = 'https' | 'ssh';

/** Select GitHub transport from non-secret declarations, never credential availability. */
export default function resolveGitProtocol(
  manifest: Pick<AgentManifest, 'git' | 'github'>,
): GitProtocol {
  if (manifest.github?.config?.gitProtocol) return manifest.github.config.gitProtocol;
  if (manifest.git?.ssh?.privateKeys.length || manifest.github?.sshKeys?.length) return 'ssh';
  return defaultGitHubCliConfiguration.gitProtocol;
}
