import { automationHash } from './automation-hash.ts';
import nativeRetirement from './native-retirement.ts';
import type { OpenClawDispatchDependencies } from './openclaw-dispatch-context.ts';
import OpenClawDispatchStore from './openclaw-dispatch-state.ts';
import { operatorInputEvent } from './openclaw-session-input.ts';
import { sessionObject, type DispatchCaller } from './openclaw-session-create.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';

/** unmanaged cleanup uses native session custody, never issue admission or git preservation. */
export default async function retireOpenClawNative(input: {
  dependencies: OpenClawDispatchDependencies;
  manifest: AgentManifest;
  workspace: string;
  caller: DispatchCaller;
  operator: boolean;
  authority: DispatchAuthority;
  native: string;
  digest?: string;
}) {
  const { dependencies: deps, manifest, authority, caller } = input;
  if (!input.operator) throw new Error('dispatch-operator-required');
  if (!input.native.startsWith(`agent:${manifest.agent.id}:`))
    throw new Error('native-retirement-agent-mismatch');
  await authority.assertCurrent?.();
  const selected = await deps.intake.select(manifest, input.workspace, { resolvePolicy: false });
  const journal = new OpenClawDispatchStore(deps.root, selected.store.location.scope);
  return deps.credential.use(authority, async (request) => {
    const nativeInput = () =>
      operatorInputEvent({
        request,
        senderIsOwner: true,
        sessionKey: caller.sessionKey,
        sessionId: caller.sessionId,
        runId: caller.runId,
        retained: [],
      });
    const turn = await nativeInput();
    return nativeRetirement({
      root: deps.root,
      binding: {
        runtime: 'openclaw',
        agentId: manifest.agent.id,
        workspace: selected.workspace,
        namespace: deps.intake.dependencies.namespace,
        session: caller.sessionKey,
        incarnation: caller.sessionId,
      },
      target: input.native,
      digest: input.digest,
      turnId: caller.runId,
      inputId: turn.inputEventId,
      now: (deps.now ?? Date.now)(),
      effects:
        'Archive this exact unmanaged native session using normal OpenClaw cleanup. Native archival may stop its work and enqueue checkout/local-branch reclamation; local-only work may be lost. No issue, assignment or remote branch is changed. Existing explicit cleanup intent authorizes apply; do not ask for another conversational confirmation.',
      assertCurrent: async () => {
        await authority.assertCurrent?.();
        const fresh = await deps.intake.dependencies.manifestService.loadForAgentId(
          manifest.agent.id,
          'service',
        );
        if (
          fresh.status !== 'loaded' ||
          fresh.scope.workspaceDir !== selected.workspace ||
          automationHash(fresh.manifest) !== automationHash(manifest) ||
          (await nativeInput()).inputEventId !== turn.inputEventId
        )
          throw new Error('native-retirement-binding-changed');
      },
      managed: async () =>
        (await journal.read()).records.some(
          (record) => record.threadId === input.native || record.request?.key === input.native,
        ),
      observe: async () => {
        const row = sessionObject(
          sessionObject(await request('sessions.describe', { key: input.native })).session,
        );
        if (
          row.key !== input.native ||
          row.agentId !== manifest.agent.id ||
          typeof row.sessionId !== 'string' ||
          !row.sessionId
        )
          throw new Error('native-retirement-target-mismatch');
        const cwd = row.spawnedCwd ?? row.workspaceDir;
        return {
          id: input.native,
          incarnation: row.sessionId,
          ...(typeof cwd === 'string' ? { cwd } : {}),
          ...(typeof row.lifecycleRevision === 'string' ? { revision: row.lifecycleRevision } : {}),
          archived: row.archived === true || Boolean(row.archivedAt),
        };
      },
      archive: async (target) => {
        await request('sessions.patch', {
          key: target.id,
          expectedSessionId: target.incarnation,
          ...(target.revision ? { expectedLifecycleRevision: target.revision } : {}),
          archived: true,
        });
      },
    });
  });
}
