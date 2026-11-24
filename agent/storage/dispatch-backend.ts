import type { BoundStorage } from './storage-lifecycle.ts';
import type { AgentRows } from './workflow-records.ts';

type DispatchEnvelope = AgentRows['dispatchState']['value'] & {
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
    async read() {
      const { dispatchState, dispatchRecords } = await agent.read({
        dispatchState: { scope },
        dispatchRecords: { scope },
      });
      const header = dispatchState[0];
      if (!header && !dispatchRecords.length) return;
      if (!header || dispatchRecords.some(({ id, value }) => value?.id !== id))
        throw new Error('dispatch-state-invalid');
      return { ...header.value, records: dispatchRecords.map(({ value }) => value) };
    },
    async save({ records, ...value }: DispatchEnvelope) {
      await agent.write([
        { table: 'dispatchState', action: 'save', row: { scope, value } },
        { table: 'dispatchRecords', action: 'clearScope', scope },
        ...records.map((record) => ({
          table: 'dispatchRecords' as const,
          action: 'insert' as const,
          row: { scope, id: record.id, value: record },
        })),
      ]);
    },
  };
}
