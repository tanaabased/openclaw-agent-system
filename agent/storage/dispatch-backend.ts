import type { PrivateStateContention } from '../../core/private-state-file-lock.ts';
import type { PrivateStateLockGuard } from '../../core/private-state-lock-context.ts';
import withWorkflowLock from './workflow-lock.ts';
import type { BoundStorage } from './storage-lifecycle.ts';
import type { AgentRows } from './workflow-records.ts';

export type DispatchEnvelope = AgentRows['dispatchState']['value'] & {
  records: AgentRows['dispatchRecords']['value'][];
};

// OpenClaw keeps its pickup journal under the intake root, independently of issue dispatch.
export const pickupDispatchScope = (scope: string) => 'pickup:' + scope;

export function sqliteDispatchPersistence(
  agent: BoundStorage['agent'] | undefined,
  scope: string,
  resetRoot?: string,
) {
  if (!agent) return;
  return {
    lockPath: agent.workflowLockPath('dispatch', scope),
    agentStorage: agent,
    resetRoot,
    read: () => agent.readDispatch(scope),
    save(state: DispatchEnvelope, expected: DispatchEnvelope) {
      return agent.saveDispatch(scope, state, expected);
    },
  };
}

// Reset and native dispatch share this lease while choosing and checkpointing effects.
export function withDispatchLock<T>(
  path: string,
  runtime: 'codex' | 'openclaw',
  operation: PrivateStateContention['operation'],
  wait: boolean,
  signal: AbortSignal | undefined,
  run: (guard: PrivateStateLockGuard) => Promise<T>,
) {
  return withWorkflowLock(path, runtime + ' issue dispatch', run, {
    contention: {
      category: 'dispatch',
      operation,
      timeoutMs: wait ? 10000 : 0,
      retryMs: 250,
      signal,
    },
  });
}
