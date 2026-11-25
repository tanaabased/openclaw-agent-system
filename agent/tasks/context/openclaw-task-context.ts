import OpenClawDispatchStore from '../dispatch/openclaw-dispatch-state.ts';
import { sqliteDispatchPersistence, pickupDispatchScope } from '../../storage/dispatch-backend.ts';
import type { SqliteInstallation } from '../../storage/storage-lifecycle.ts';
import { bindAgentStore, bindIntakeStore } from '../../storage/backend.ts';
import { realpath } from 'node:fs/promises';
import { intakeLocation } from '../../../channels/github/intake/record-store.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import assignmentIntakePolicy from '../../automations/assignment-intake-policy.ts';

export interface OpenClawTaskContextDependencies {
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
  const agent = await bindAgentStore(manifest.agent.id, deps.sqliteInstallation);
  const store = bindIntakeStore(
    intakeLocation({
      runtime: 'openclaw',
      root: deps.root,
      namespace: deps.namespace,
      workspaceDir: workspace,
      agentId: manifest.agent.id,
    }),
    agent,
  );
  await store.identities.hydrate(manifest.github?.notifications);
  const dispatch = (root: string) => {
    const scope = store.location.scope;
    const pickup = root === deps.root && deps.resetRoot && deps.resetRoot !== root;
    return new OpenClawDispatchStore(
      scope,
      sqliteDispatchPersistence(agent, pickup ? pickupDispatchScope(scope) : scope),
    );
  };
  return { selected, store, workspace, dispatch, sessionStorage: agent };
}

export type OpenClawTaskContext = Awaited<ReturnType<typeof selectOpenClawTaskContext>>;
