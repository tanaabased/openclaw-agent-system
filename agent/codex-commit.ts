import { isDeepStrictEqual } from 'node:util';

import { stateSnapshotConflictCode } from '../core/merge-state-snapshot.ts';
import codexCapacity, { codexItemOccupied } from './codex-capacity.ts';
import type { DispatchState } from './codex-dispatch-state.ts';

/** reject competing effect/authority changes, checking capacity and branch ownership at commit. */
export default function codexCommit(
  limit?: number,
  ownerId?: string,
  operation?: 'delivery' | 'continuation',
) {
  // Task-local effects do not own intake counters or native activity observations.
  const effectState = (record: DispatchState['records'][number] | undefined) => {
    if (operation === undefined || !record) return record;
    const effect = { ...record };
    delete effect.capacityObservation;
    delete effect.nativeInactive;
    delete effect.lifecycleCheckedAt;
    delete effect.intakeReportedAt;
    return effect;
  };
  return {
    reconcile(before: DispatchState, proposed: DispatchState, current: DispatchState) {
      const conflict = (snapshotConflict: 'occurrence' | 'owner') => {
        throw Object.assign(new Error(stateSnapshotConflictCode), {
          code: stateSnapshotConflictCode,
          snapshotConflict,
        });
      };
      for (const key of ['run', 'continuationRun'] as const) {
        if (
          (operation === undefined || !isDeepStrictEqual(before[key], proposed[key])) &&
          !isDeepStrictEqual(before[key], current[key])
        )
          conflict('occurrence');
      }
      for (const previous of before.records) {
        const desired = proposed.records.find((r) => r.id === previous.id);
        if (
          (previous.id === ownerId || !isDeepStrictEqual(previous, desired)) &&
          !isDeepStrictEqual(
            effectState(previous),
            effectState(current.records.find((r) => r.id === previous.id)),
          )
        )
          conflict('owner');
      }
    },
    validate(before: DispatchState, after: DispatchState) {
      const reserved = after.records.some(
        (record) =>
          codexItemOccupied(record) &&
          !before.records.some(
            (previous) => previous.id === record.id && codexItemOccupied(previous),
          ),
      );
      if (
        limit !== undefined &&
        reserved &&
        codexCapacity(after.records, limit, after.projectPickup).occupied > limit
      )
        throw new Error('dispatch-at-capacity');
      for (const record of after.records) {
        const previous = before.records.find((r) => r.id === record.id);
        if (
          isDeepStrictEqual(previous?.issueBranch, record.issueBranch) &&
          isDeepStrictEqual(previous?.delivery?.binding, record.delivery?.binding) &&
          previous?.delivery?.localBranch === record.delivery?.localBranch
        )
          continue;
        const branch =
          record.issueBranch?.name ??
          record.delivery?.localBranch ??
          record.delivery?.binding.branch;
        if (
          branch &&
          after.records.some(
            (other) =>
              other.id !== record.id &&
              other.project?.commonDir === record.project?.commonDir &&
              (other.issueBranch?.name === branch ||
                (other.delivery?.localBranch ?? other.delivery?.binding.branch) === branch),
          )
        )
          throw new Error('codex-branch-owner-mismatch');
      }
    },
  };
}
