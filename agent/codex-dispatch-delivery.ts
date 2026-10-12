import type { DispatchState } from './codex-dispatch-state.ts';
import type IntakeRecordStore from '../channels/github/intake/record-store.ts';

export interface DispatchDeliveryContext {
  state: DispatchState;
  intakeStore: IntakeRecordStore;
  save(): Promise<void>;
  deliveredReports(reports: NonNullable<DispatchState['reports']>): Promise<string[]>;
}

/** Persist proven delivery before further work, including when a later check must stop. */
export default async function acknowledgeDispatchDelivery(context: DispatchDeliveryContext) {
  const { state, intakeStore, save, deliveredReports } = context;
  const reports = state.reports ?? [];
  if (!reports.length) return;
  const delivered = new Set(await deliveredReports(reports));
  const ids = new Set(
    reports.filter((entry) => delivered.has(entry.response)).flatMap((entry) => entry.notices),
  );
  if (!ids.size) return;
  // Clear intake first. If the dispatch save fails, its retained receipt safely repeats this acknowledgment.
  await intakeStore.exclusive(async (scan, saveScan) => {
    if (scan?.notices?.some((entry) => ids.has(entry.id)))
      await saveScan({ ...scan, notices: scan.notices.filter((entry) => !ids.has(entry.id)) });
  });
  state.notices = (state.notices ?? []).filter((entry) => !ids.has(entry.id));
  state.reports = reports.filter((entry) => !delivered.has(entry.response));
  await save();
}
