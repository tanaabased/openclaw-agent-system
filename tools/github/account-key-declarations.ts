import type { ManifestDiagnostic } from '../../utils/manifest-types.ts';
import parseSshPublicKey, { looksLikeSshPublicKey } from '../../utils/parse-ssh-public-key.ts';
import type { GitHubManifestConfiguration, GitHubPublicKeySource } from './config-schema.ts';

export type GitHubAccountKeyCategory = 'ssh' | 'ssh-signing';

export interface GitHubAccountKeyCategoryConfiguration {
  category: GitHubAccountKeyCategory;
  endpoint: '/user/keys' | '/user/ssh_signing_keys';
  label: string;
  sources: readonly GitHubPublicKeySource[];
}

/** Normalize configured authentication and signing sources into ordered GitHub categories. */
export function githubAccountKeyCategories(
  configuration: GitHubManifestConfiguration,
): GitHubAccountKeyCategoryConfiguration[] {
  return [
    ...(configuration.sshKeys
      ? [
          {
            category: 'ssh' as const,
            endpoint: '/user/keys' as const,
            label: 'SSH authentication',
            sources: configuration.sshKeys,
          },
        ]
      : []),
    ...(configuration.sshSigningKeys
      ? [
          {
            category: 'ssh-signing' as const,
            endpoint: '/user/ssh_signing_keys' as const,
            label: 'SSH signing',
            sources: configuration.sshSigningKeys,
          },
        ]
      : []),
  ];
}

/** Treat explicit keys and key-looking auto sources as inline declarations. */
export function isInlineGitHubAccountKeySource(source: GitHubPublicKeySource): boolean {
  return source.type === 'key' || (source.type === 'auto' && looksLikeSshPublicKey(source.source));
}

function sourceFieldPath(category: GitHubAccountKeyCategory, index: number): string {
  return `/github/${category === 'ssh' ? 'ssh-keys' : 'ssh-signing-keys'}/${index}`;
}

/** Validate deterministic account-key declarations without reading files or credentials. */
export function validateGitHubAccountKeyDeclarations(
  configuration: GitHubManifestConfiguration,
): ManifestDiagnostic[] {
  const categories = githubAccountKeyCategories(configuration);
  if (categories.length === 0) return [];

  const diagnostics: ManifestDiagnostic[] = [];
  if (!configuration.username) {
    diagnostics.push({
      code: 'github-account-key-username-required',
      fieldPath: '/github/username',
      message: 'GitHub account key management requires an explicit github.username.',
      severity: 'error',
    });
  }
  if (!configuration.token) {
    diagnostics.push({
      code: 'github-account-key-token-required',
      fieldPath: '/github/token',
      message: 'GitHub account key management requires an explicit github.token binding.',
      severity: 'error',
    });
  }

  for (const { category, sources } of categories) {
    const fingerprints = new Set<string>();
    sources.forEach((source, index) => {
      const fieldPath = sourceFieldPath(category, index);
      if (!isInlineGitHubAccountKeySource(source) && /^~[^/]/u.test(source.source)) {
        diagnostics.push({
          code: 'github-account-key-path-invalid',
          fieldPath,
          message:
            'GitHub account key paths may use only workspace-relative, absolute, or ~/ paths.',
          severity: 'error',
        });
        return;
      }
      if (!isInlineGitHubAccountKeySource(source)) return;

      try {
        const key = parseSshPublicKey(source.source);
        if (fingerprints.has(key.fingerprint)) {
          diagnostics.push({
            code: 'github-account-key-duplicate',
            fieldPath,
            message: `The ${category} key ${key.fingerprint} is declared more than once.`,
            severity: 'error',
          });
        }
        fingerprints.add(key.fingerprint);
      } catch (error) {
        diagnostics.push({
          code: 'github-account-key-invalid',
          fieldPath,
          message: error instanceof Error ? error.message : 'The GitHub SSH public key is invalid.',
          severity: 'error',
        });
      }
    });
  }
  return diagnostics;
}
