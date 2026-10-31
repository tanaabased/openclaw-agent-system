import type { DispatchState, SharedDispatchRecord } from './dispatch-state.ts';
import { historySoftBytes } from './history-state.ts';
import { verifiedTerminalCleanup } from './retain-dispatch-history.ts';

export const dispatchStorageLimits = {
  cleanup: historySoftBytes,
  warning: 16 * 1024 * 1024,
  admission: 32 * 1024 * 1024,
  emergency: 64 * 1024 * 1024,
  reporting: 1024 * 1024,
  file: 65 * 1024 * 1024,
};

export function dispatchStorageLevel(contentBytes: number) {
  return contentBytes >= dispatchStorageLimits.emergency
    ? 'emergency'
    : contentBytes >= dispatchStorageLimits.admission
      ? 'paused'
      : contentBytes >= dispatchStorageLimits.warning
        ? 'warning'
        : 'normal';
}

export function dispatchStorageViolation(
  bytes: { contentBytes: number; totalBytes: number },
  admission: boolean,
) {
  if (
    bytes.contentBytes > dispatchStorageLimits.emergency ||
    bytes.totalBytes > dispatchStorageLimits.file
  )
    return 'dispatch-state-capacity';
  if (admission && bytes.contentBytes >= dispatchStorageLimits.admission)
    return 'dispatch-storage-admission-paused';
}

/** Only generated report text uses the reserve; workflow content always counts. */
export function dispatchStorageBytes<R extends SharedDispatchRecord>(state: DispatchState<R>) {
  const contents = JSON.stringify(state);
  const totalBytes = Buffer.byteLength(contents);
  const reportBytes = (value: object | undefined, stripped: object | undefined) =>
    value
      ? Buffer.byteLength(JSON.stringify(value)) - Buffer.byteLength(JSON.stringify(stripped))
      : 0;
  const contentBytes =
    totalBytes -
    reportBytes(state.run, state.run && { ...state.run, response: undefined }) -
    reportBytes(
      state.intakeReport,
      state.intakeReport && { ...state.intakeReport, response: undefined },
    ) -
    reportBytes(
      state.continuationRun,
      state.continuationRun && { ...state.continuationRun, responses: undefined },
    );
  return { contents, contentBytes, totalBytes };
}

export function dispatchStoragePressure<R extends SharedDispatchRecord>(state: DispatchState<R>) {
  const { contentBytes, totalBytes } = dispatchStorageBytes(state);
  const level = dispatchStorageLevel(contentBytes);
  const protectedRecords: Record<string, number> = {};
  for (const record of state.records) {
    if (record.retainedHistory?.terminal || verifiedTerminalCleanup(record)) continue;
    const reason =
      record.retired || record.retirement ? 'native-cleanup-unverified' : 'active-workflow';
    protectedRecords[reason] = (protectedRecords[reason] ?? 0) + 1;
  }
  return {
    level,
    contentBytes,
    totalBytes,
    thresholds: dispatchStorageLimits,
    reclaimedBytes: state.storageReclaimedBytes ?? 0,
    protectedRecords,
  };
}

/** Coarse bands make transitions and substantial growth visible without byte-by-byte alerts. */
export function dispatchStorageNotice<R extends SharedDispatchRecord>(state: DispatchState<R>) {
  const pressure = dispatchStoragePressure(state);
  const key =
    pressure.level === 'normal'
      ? 'normal'
      : pressure.level + ':' + Math.floor(pressure.contentBytes / (8 * 1024 * 1024));
  const message = `Journal: ${(pressure.contentBytes / 1024 / 1024).toFixed(1)} MiB content; warn 16 MiB, pause new work 32 MiB, emergency 64 MiB (+1 MiB reporting). Last offload reclaimed ${pressure.reclaimedBytes} bytes. Protected records: ${
    Object.entries(pressure.protectedRecords)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ') || 'none'
  }.`;
  return { ...pressure, key, message };
}

export function assertDispatchStorage<R extends SharedDispatchRecord>(
  state: DispatchState<R>,
  admission = false,
) {
  const bytes = dispatchStorageBytes(state);
  if (dispatchStorageViolation(bytes, admission) === 'dispatch-state-capacity')
    throw Object.assign(new Error('dispatch-state-capacity'), {
      code: 'dispatch-state-capacity',
      operation: 'save existing task progress',
      ...dispatchStoragePressure(state),
      remediation:
        'Committed state is preserved. Reconcile verified retired history and retry in the same chat; do not reset the journal.',
    });
  if (dispatchStorageViolation(bytes, admission) === 'dispatch-storage-admission-paused')
    throw Object.assign(new Error('dispatch-storage-admission-paused'), {
      code: 'dispatch-storage-admission-paused',
      operation: 'admit new task',
      ...dispatchStoragePressure(state),
      remediation:
        'Leave assignments pending. Reconcile retired history; existing work can progress and retire. Admission resumes below 32 MiB with room for the proposed task.',
    });
  return bytes.contents;
}
