import { realpath } from 'node:fs/promises';
import GitHubIdentityCache from '../../../channels/github/identity-cache.ts';
import IntakeRecordStore, { intakeLocation } from '../../../channels/github/intake/record-store.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import assignmentIntakePolicy from '../../assignment-intake-policy.ts';

export interface OpenClawTaskContextDependencies {
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
  const store = new IntakeRecordStore(
    intakeLocation({
      runtime: 'openclaw',
      root: deps.root,
      namespace: deps.namespace,
      workspaceDir: workspace,
      agentId: manifest.agent.id,
      resetRoot: deps.resetRoot,
    }),
  );
  await new GitHubIdentityCache(store.location).hydrate(manifest.github?.notifications);
  return { selected, store, workspace };
}
