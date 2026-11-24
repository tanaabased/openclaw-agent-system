import type { SqliteInstallation } from '../../storage/storage-lifecycle.ts';
import { bindIntakeStore, type StorageBackend } from '../../storage/intake-backend.ts';
import { realpath } from 'node:fs/promises';
import GitHubIdentityCache from '../../../channels/github/identity-cache.ts';
import { intakeLocation } from '../../../channels/github/intake/record-store.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import assignmentIntakePolicy from '../../automations/assignment-intake-policy.ts';

export interface OpenClawTaskContextDependencies {
  storageBackend?: StorageBackend;
  sqliteInstallation?: SqliteInstallation;
  root: string;
  resetRoot?: string;
  namespace: string;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
}

export async function selectOpenClawTaskContext(
  deps: OpenClawTaskContextDependencies,
  manifest: AgentManifest,
  workspaceDir: string,
  options: { resolvePolicy?: boolean } = {},
) {
  const workspace = await realpath(workspaceDir);
  const selected =
    options.resolvePolicy === false ? undefined : assignmentIntakePolicy(manifest, 'openclaw');
  const store = await bindIntakeStore(
    intakeLocation({
      runtime: 'openclaw',
      root: deps.root,
      namespace: deps.namespace,
      workspaceDir: workspace,
      agentId: manifest.agent.id,
      resetRoot: deps.resetRoot,
    }),
    manifest.agent.id,
    deps.sqliteInstallation,
    deps.storageBackend,
  );
  await new GitHubIdentityCache(store.location).hydrate(manifest.github?.notifications);
  return { selected, store, workspace };
}

export type OpenClawTaskContext = Awaited<ReturnType<typeof selectOpenClawTaskContext>>;
