import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { AgentSystemCliResult } from '../../lib/tool-types.ts';
import parseSshPublicKey, {
  looksLikeSshPublicKey,
  type ParsedSshPublicKey,
} from '../../utils/parse-ssh-public-key.ts';
import type { AgentManifest, ManifestDiagnostic } from '../../utils/manifest-types.ts';
import type { GitHubManifestConfiguration, GitHubPublicKeySource } from './config-schema.ts';
import type GitHubAccountClient from './account-client.ts';

const maximumPublicKeyFileBytes = 64 * 1024;

export type GitHubAccountKeyCategory = 'ssh' | 'ssh-signing';

export interface GitHubAccountKeyInspection {
  category: GitHubAccountKeyCategory;
  declared: number;
  missingFingerprints: string[];
  status: 'missing' | 'ready';
}

export interface GitHubAccountKeyReconciliation {
  category: GitHubAccountKeyCategory;
  created: number;
  declared: number;
}

export interface GitHubAccountKeyServiceDependencies {
  client: Pick<GitHubAccountClient, 'connect'>;
  homeDirectory?: string;
}

interface ResolvedGitHubAccountKey extends ParsedSshPublicKey {
  title: string;
}

interface KeyCategoryConfiguration {
  category: GitHubAccountKeyCategory;
  endpoint: '/user/keys' | '/user/ssh_signing_keys';
  label: string;
  sources: readonly GitHubPublicKeySource[];
}

export class GitHubAccountKeyError extends Error {
  override name = 'GitHubAccountKeyError';

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function keyCategories(configuration: GitHubManifestConfiguration): KeyCategoryConfiguration[] {
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

function sourceFieldPath(category: GitHubAccountKeyCategory, index: number): string {
  return `/github/${category === 'ssh' ? 'ssh-keys' : 'ssh-signing-keys'}/${index}`;
}

function isInlineSource(source: GitHubPublicKeySource): boolean {
  return source.type === 'key' || (source.type === 'auto' && looksLikeSshPublicKey(source.source));
}

function defaultKeyTitle(
  agentId: string,
  category: GitHubAccountKeyCategory,
  fingerprint: string,
): string {
  const fingerprintHex = Buffer.from(fingerprint.slice('SHA256:'.length), 'base64').toString('hex');
  const keyKind = category === 'ssh' ? 'ssh-authentication' : 'ssh-signing';
  return `agent-system-${agentId}-${keyKind}-${fingerprintHex.slice(0, 12)}`;
}

/** Validate deterministic account-key declarations without reading files or resolving credentials. */
export function validateGitHubAccountKeyDeclarations(
  configuration: GitHubManifestConfiguration,
): ManifestDiagnostic[] {
  const categories = keyCategories(configuration);
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
      if (!isInlineSource(source) && /^~[^/]/u.test(source.source)) {
        diagnostics.push({
          code: 'github-account-key-path-invalid',
          fieldPath,
          message:
            'GitHub account key paths may use only workspace-relative, absolute, or ~/ paths.',
          severity: 'error',
        });
        return;
      }
      if (!isInlineSource(source)) return;

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

function commandError(
  code: string,
  action: string,
  result: AgentSystemCliResult,
): GitHubAccountKeyError {
  const details = result.stderr.trim() || result.stdout.trim();
  return new GitHubAccountKeyError(
    code,
    details ? `GitHub could not ${action}: ${details}` : `GitHub could not ${action}.`,
  );
}

/** Inspect and add manifest-declared GitHub SSH authentication and signing keys. */
export default class GitHubAccountKeyService {
  readonly #dependencies: GitHubAccountKeyServiceDependencies;

  constructor(dependencies: GitHubAccountKeyServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(context: {
    manifest: AgentManifest;
    workspaceDir: string;
  }): Promise<GitHubAccountKeyInspection[]> {
    const categories = await this.#resolveCategories(context);
    const client = await this.#dependencies.client.connect(context);
    const inspections: GitHubAccountKeyInspection[] = [];
    for (const category of categories) {
      const remote = await this.#list(category, client);
      const missingFingerprints = category.keys
        .filter(({ fingerprint }) => !remote.has(fingerprint))
        .map(({ fingerprint }) => fingerprint);
      inspections.push({
        category: category.category,
        declared: category.keys.length,
        missingFingerprints,
        status: missingFingerprints.length === 0 ? 'ready' : 'missing',
      });
    }
    return inspections;
  }

  async reconcile(context: {
    manifest: AgentManifest;
    workspaceDir: string;
  }): Promise<GitHubAccountKeyReconciliation[]> {
    const categories = await this.#resolveCategories(context);
    const client = await this.#dependencies.client.connect(context);
    const current = await Promise.all(categories.map((category) => this.#list(category, client)));
    const results: GitHubAccountKeyReconciliation[] = [];

    for (const [index, category] of categories.entries()) {
      const remote = current[index] ?? new Set<string>();
      const missing = category.keys.filter(({ fingerprint }) => !remote.has(fingerprint));
      for (const key of missing) {
        try {
          await this.#create(category, key, client);
        } catch (error) {
          const converged = await this.#list(category, client);
          if (!converged.has(key.fingerprint)) throw error;
        }
      }

      const verified = await this.#list(category, client);
      const unresolved = category.keys.find(({ fingerprint }) => !verified.has(fingerprint));
      if (unresolved) {
        throw new GitHubAccountKeyError(
          'github-account-key-verification-failed',
          `GitHub ${category.label} key ${unresolved.fingerprint} was still missing after installation.`,
        );
      }
      results.push({
        category: category.category,
        created: missing.length,
        declared: category.keys.length,
      });
    }
    return results;
  }

  async #resolveCategories(context: {
    manifest: AgentManifest;
    workspaceDir: string;
  }): Promise<
    Array<Omit<KeyCategoryConfiguration, 'sources'> & { keys: ResolvedGitHubAccountKey[] }>
  > {
    const configuration = context.manifest.github ?? {};
    return Promise.all(
      keyCategories(configuration).map(async (category) => ({
        ...category,
        keys: await this.#resolveSources(category, context),
      })),
    );
  }

  async #resolveSources(
    category: KeyCategoryConfiguration,
    context: { manifest: AgentManifest; workspaceDir: string },
  ): Promise<ResolvedGitHubAccountKey[]> {
    const keys: ResolvedGitHubAccountKey[] = [];
    const fingerprints = new Set<string>();
    for (const [index, source] of category.sources.entries()) {
      let key: ParsedSshPublicKey;
      try {
        key = isInlineSource(source)
          ? parseSshPublicKey(source.source)
          : parseSshPublicKey(await this.#readKeyFile(source.source, context.workspaceDir));
      } catch (error) {
        throw new GitHubAccountKeyError(
          'github-account-key-source-invalid',
          `GitHub ${category.label} key source ${index + 1} is invalid: ${error instanceof Error ? error.message : 'The key could not be resolved.'}`,
          { cause: error },
        );
      }
      if (fingerprints.has(key.fingerprint)) {
        throw new GitHubAccountKeyError(
          'github-account-key-duplicate',
          `GitHub ${category.label} key ${key.fingerprint} is declared more than once.`,
        );
      }
      fingerprints.add(key.fingerprint);
      keys.push({
        ...key,
        title:
          source.title?.trim() ||
          defaultKeyTitle(context.manifest.agent.id, category.category, key.fingerprint),
      });
    }
    return keys;
  }

  async #readKeyFile(source: string, workspaceDir: string): Promise<string> {
    let path: string;
    if (source === '~' || source.startsWith('~/')) {
      if (!this.#dependencies.homeDirectory) {
        throw new Error('The home directory is unavailable for this GitHub account key path.');
      }
      path = resolve(this.#dependencies.homeDirectory, source.slice(2));
    } else {
      path = isAbsolute(source) ? resolve(source) : resolve(workspaceDir, source);
    }

    const pathStats = await lstat(path);
    if (!pathStats.isFile()) {
      throw new Error('The GitHub account key path must be a regular file, not a link.');
    }
    if (pathStats.size > maximumPublicKeyFileBytes) {
      throw new Error('The GitHub account key file exceeds the supported size limit.');
    }

    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error('The GitHub account key path must be a regular file.');
      if (stats.size > maximumPublicKeyFileBytes) {
        throw new Error('The GitHub account key file exceeds the supported size limit.');
      }
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }

  async #list(
    category: Omit<KeyCategoryConfiguration, 'sources'>,
    client: { execute(argv: string[], stdin?: string): Promise<AgentSystemCliResult> },
  ): Promise<Set<string>> {
    const result = await client.execute(['api', '--paginate', '--slurp', category.endpoint]);
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      throw commandError('github-account-key-list-failed', `list ${category.label} keys`, result);
    }

    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch (error) {
      throw new GitHubAccountKeyError(
        'github-account-key-response-invalid',
        `GitHub returned invalid ${category.label} key data.`,
        { cause: error },
      );
    }
    const pages = Array.isArray(value) && value.every(Array.isArray) ? value : [value];
    const fingerprints = new Set<string>();
    for (const page of pages) {
      if (!Array.isArray(page)) {
        throw new GitHubAccountKeyError(
          'github-account-key-response-invalid',
          `GitHub returned invalid ${category.label} key data.`,
        );
      }
      for (const item of page) {
        if (!item || typeof item !== 'object' || !('key' in item) || typeof item.key !== 'string') {
          continue;
        }
        try {
          fingerprints.add(parseSshPublicKey(item.key).fingerprint);
        } catch {
          // Unrelated legacy or malformed remote keys do not prevent matching declared keys.
        }
      }
    }
    return fingerprints;
  }

  async #create(
    category: Omit<KeyCategoryConfiguration, 'sources'>,
    key: ResolvedGitHubAccountKey,
    client: { execute(argv: string[], stdin?: string): Promise<AgentSystemCliResult> },
  ): Promise<void> {
    const result = await client.execute(
      ['api', '--method', 'POST', category.endpoint, '--input', '-'],
      JSON.stringify({ key: key.key, title: key.title }),
    );
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      throw commandError(
        'github-account-key-create-failed',
        `add ${category.label} key ${key.fingerprint}`,
        result,
      );
    }
  }
}
