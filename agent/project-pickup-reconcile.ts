import { automationHash } from './automation-hash.ts';
import type { PickupEnrollment } from './project-pickup-enrollment.ts';
import type { ProjectPickupState } from './project-pickup-state.ts';

/** live selection policy owns future work; retained effects keep their original scope. */
export default async function reconcileProjectPickup(
  state: { projectPickup?: ProjectPickupState },
  save: () => Promise<void>,
  record: Pick<PickupEnrollment, 'enrollment' | 'timezone' | 'repository'> &
    Partial<Pick<PickupEnrollment, 'instanceId'>>,
  commit: () => Promise<void>,
  before?: PickupEnrollment,
) {
  const previous = state.projectPickup;
  const changed =
    previous &&
    (automationHash(previous.enrollment) !== automationHash(record.enrollment) ||
      previous.timezone !== record.timezone);
  if (changed) {
    state.projectPickup = {
      ...previous,
      enrollment: structuredClone(record.enrollment),
      timezone: record.timezone,
      operations: previous.operations.map((operation) => {
        const retained = {
          ...operation,
          enrollment: operation.enrollment ?? structuredClone(previous.enrollment),
          repository:
            operation.repository ??
            before?.repository ??
            (previous.enrollment.repositoryNodeId === record.enrollment.repositoryNodeId
              ? record.repository
              : undefined),
        };
        if (
          operation.attemptedAt === undefined &&
          !operation.receipt &&
          ['discovering', 'selecting', 'reserved', 'failed'].includes(operation.phase)
        )
          return {
            ...retained,
            phase: 'cancelled' as const,
            candidates: [],
            code: 'project-pickup-configuration-changed',
          };
        return retained;
      }),
    };
    const consumed = state.projectPickup.operations.filter(
      (operation) =>
        operation.attemptedAt !== undefined ||
        operation.receipt ||
        (operation.phase === 'cancelled' &&
          operation.code !== 'project-pickup-configuration-changed'),
    );
    state.projectPickup.highWater = consumed.length
      ? Math.max(...consumed.map((operation) => operation.window.opensAt))
      : undefined;
    // save original effect ownership before publishing the replacement enrollment.
    await save();
  }
  await commit();
}
