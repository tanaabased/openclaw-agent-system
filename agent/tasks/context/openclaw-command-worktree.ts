import { bindAgentStore } from '../../storage/backend.ts';
import { sqliteDispatchPersistence } from '../../storage/dispatch-backend.ts';
import { realpath } from 'node:fs/promises';

import { intakeLocation } from '../../../channels/github/intake/record-store.ts';
import type { AgentManifestScope } from '../../../manifest/service.ts';
import OpenClawDispatchStore from '../dispatch/openclaw-dispatch-state.ts';
import type { OpenClawTaskContextDependencies } from './openclaw-task-context.ts';

interface CommandSessionBinding {
  sessionKey?: string;
  sessionId?: string;
}

interface CommandWorktreeDependencies {
  taskContext: Pick<OpenClawTaskContextDependencies, 'root' | 'namespace' | 'sqliteInstallation'>;
  readSession(
    sessionKey: string,
  ): Promise<
    { sessionId: string; archivedAt?: number; spawnedCwd?: string; execHost?: string } | undefined
  >;
}

export default async function resolveOpenClawCommandWorktree(
  { taskContext, readSession }: CommandWorktreeDependencies,
  agent: AgentManifestScope & { agentId: string },
  { sessionKey, sessionId }: CommandSessionBinding,
): Promise<string | undefined> {
  if (!sessionKey || !sessionId) return;
  const workspaceDir = await realpath(agent.workspaceDir);
  const location = intakeLocation({
    runtime: 'openclaw',
    root: taskContext.root,
    namespace: taskContext.namespace,
    agentId: agent.agentId,
    workspaceDir,
  });
  const storage = await bindAgentStore(agent.agentId, taskContext.sqliteInstallation);
  const journal = new OpenClawDispatchStore(
    location.scope,
    sqliteDispatchPersistence(storage, location.scope),
  );
  const owners = (await journal.read()).records.filter(
    (record) => record.threadId === sessionKey || record.request?.key === sessionKey,
  );
  const [record] = owners;
  if (
    owners.length !== 1 ||
    !record?.worktree ||
    record.threadId !== sessionKey ||
    record.request?.key !== sessionKey ||
    record.request.agentId !== agent.agentId ||
    record.request.cwd !== record.worktree ||
    !record.sessionCreation?.verified ||
    record.sessionCreation.sessionId !== sessionId ||
    record.reset ||
    record.cleanupPending ||
    record.retirement ||
    record.supersededBy
  )
    return;

  const session = await readSession(sessionKey);
  if (
    !session ||
    session.archivedAt ||
    session.sessionId !== sessionId ||
    !session.spawnedCwd ||
    session.execHost === 'node'
  )
    return;

  return (await realpath(session.spawnedCwd)) === record.worktree ? record.worktree : undefined;
}
