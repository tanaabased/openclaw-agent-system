import CodexDispatchStore from '../dispatch/codex-dispatch-state.ts';
import { sqliteDispatchPersistence } from '../../storage/dispatch-backend.ts';
import codexStorageLocation from '../../storage/codex-storage.ts';
import { bindAgentStore, bindIntakeStore } from '../../storage/backend.ts';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { IntakeError, intakeLocation } from '../../../channels/github/intake/record-store.ts';
import { inspectCodexWorkspaceBinding } from '../../identity/codex-workspace-binding.ts';
import assignmentIntakePolicy from '../../automations/assignment-intake-policy.ts';
import { assertNotificationManagement } from '../../notification-reset-state.ts';

export interface CodexTaskContextDependencies {
  codexHome?: string;
  inspectBinding?: typeof inspectCodexWorkspaceBinding;
}

export async function selectCodexTaskContext(
  pluginData: string,
  deps: CodexTaskContextDependencies,
  options: { resolvePolicy?: boolean; inspectionOnly?: boolean } = {},
) {
  const inspection = await (deps.inspectBinding ?? inspectCodexWorkspaceBinding)(pluginData);
  if (inspection.status !== 'bound') throw new IntakeError('intake-binding-unavailable');
  if (inspection.preview.status !== 'ready' || inspection.preview.manifest.status !== 'loaded')
    throw new IntakeError('intake-manifest-unavailable');
  const loaded = inspection.preview.manifest;
  const workspace = inspection.preview.workspaceDir;
  const policy =
    options.resolvePolicy === false ? undefined : assignmentIntakePolicy(loaded.manifest, 'codex');
  const requestedHome = resolve(
    deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  );
  const namespace = await realpath(requestedHome).catch(() => requestedHome);
  const agent = await bindAgentStore(loaded.manifest.agent.id, codexStorageLocation(pluginData));
  const store = bindIntakeStore(
    intakeLocation({
      runtime: 'codex',
      root: pluginData,
      namespace,
      workspaceDir: workspace,
      agentId: loaded.manifest.agent.id,
    }),
    agent,
  );
  await store.identities.hydrate(loaded.manifest.github?.notifications);
  if (!options.inspectionOnly) await assertNotificationManagement(store.location.scope, agent);
  return {
    sessionStorage: agent,
    journal: new CodexDispatchStore(
      store.location.scope,
      sqliteDispatchPersistence(agent, store.location.scope),
    ),
    policy,
    store,
    workspace,
    agentId: loaded.manifest.agent.id,
    digest: loaded.digest,
    manifest: loaded.manifest,
    manifestPath: loaded.path,
    manifestSources: loaded.sources,
    codexHome: namespace,
    automationBinding: {
      codexHome: namespace,
      inspectBinding: deps.inspectBinding,
    },
  };
}

export type CodexTaskSelection = Awaited<ReturnType<typeof selectCodexTaskContext>>;
