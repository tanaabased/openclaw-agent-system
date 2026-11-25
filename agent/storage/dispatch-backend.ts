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
    agentStorage: agent,
    resetRoot,
    read: () => agent.readDispatch(scope),
    save(state: DispatchEnvelope, expected: DispatchEnvelope) {
      return agent.saveDispatch(scope, state, expected);
    },
  };
}
