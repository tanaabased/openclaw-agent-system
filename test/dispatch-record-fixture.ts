import type { BoundStorage } from '../agent/storage/storage-lifecycle.ts';
import type { AgentRows } from '../agent/storage/workflow-records.ts';

// Seed retained rows directly so the journal can be tested against damaged and older payloads.
export async function seedDispatchRows(
  agent: BoundStorage['agent'],
  scope: string,
  state: { records: unknown[] },
) {
  const { records, ...header } = state;
  const ids = new Set<string>();
  const rows = records.map((record, index) => {
    const value = record as AgentRows['dispatchRecords']['value'];
    const id = value?.id && !ids.has(value.id) ? value.id : 'damaged-' + index;
    ids.add(id);
    return {
      table: 'dispatchRecords' as const,
      action: 'insert' as const,
      row: { scope, id, value },
    };
  });
  await agent.write([
    { table: 'dispatchRecords', action: 'clearScope', scope },
    {
      table: 'dispatchState',
      action: 'save',
      row: { scope, value: header as AgentRows['dispatchState']['value'] },
    },
    ...rows,
  ]);
}

export async function readDispatchRows(agent: BoundStorage['agent'], scope: string) {
  const { dispatchState, dispatchRecords } = await agent.read({
    dispatchState: { scope },
    dispatchRecords: { scope },
  });
  const header = dispatchState[0]?.value;
  return header && { ...header, records: dispatchRecords.map(({ value }) => value) };
}
