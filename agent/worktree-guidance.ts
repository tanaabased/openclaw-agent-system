import { resolve } from 'node:path';

import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';

import assessmentGuidance from './assessment-guidance.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import type { AgentSystemHookContext } from '../core/agent-hook-context.ts';
import isManagedWorktreeWorkspace from '../tools/git/worktree-workspace.ts';
import nodeErrorCode from '../utils/node-error-code.ts';

/** compose public canonical guidance only for verified managed-worktree turns. */
export default async function worktreeGuidance(
  loaded: AgentManifestLoadResult,
  context: AgentSystemHookContext,
): Promise<string | undefined> {
  if (
    loaded.status !== 'loaded' ||
    !context.workspaceDir ||
    !context.sessionId ||
    context.agentId !== loaded.manifest.agent.id ||
    parseAgentSessionKey(context.sessionKey ?? '')?.agentId !== loaded.manifest.agent.id ||
    resolve(context.workspaceDir) === resolve(loaded.scope.workspaceDir) ||
    !(await isManagedWorktreeWorkspace(
      loaded.scope.workspaceDir,
      loaded.manifest.git?.worktrees,
      context.workspaceDir,
    ))
  )
    return undefined;
  const parts: string[] = [];
  // partner and private memory files remain owned by the host's privacy-aware bootstrap.
  for (const file of ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'GOALS.md']) {
    try {
      const guidance = await assessmentGuidance(loaded.scope.workspaceDir, { file });
      if (guidance) parts.push(`Canonical agent file: ${guidance.path}\n${guidance.content}`);
    } catch (error) {
      if (error instanceof Error && error.cause && nodeErrorCode(error.cause) === 'ENOENT')
        continue;
      throw new Error('worktree-canonical-guidance-unavailable', { cause: error });
    }
  }
  if (!parts.length) return undefined;
  const result = [
    `Canonical agent workspace: ${loaded.scope.workspaceDir}\nExecution working directory: ${context.workspaceDir}`,
    'Apply these agent instructions alongside the target repository instructions. This context does not change the working directory or grant additional authority.',
    ...parts,
  ].join('\n\n');
  if (result.length > 60000) throw new Error('worktree-canonical-guidance-too-large');
  return result;
}
