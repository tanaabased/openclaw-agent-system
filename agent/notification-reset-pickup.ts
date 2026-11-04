import type { NotificationResetRecord } from './notification-reset-state.ts';
import type { NotificationResetAdapter, NotificationResetSnapshot } from './notification-reset.ts';

/** the same native adapter handles the two builtin jobs; tracking is cleared only once. */
export default function notificationResetPickup(
  intake: NotificationResetAdapter,
  pickup: NotificationResetAdapter,
  pickupSnapshot: () => Promise<NotificationResetSnapshot | undefined>,
): NotificationResetAdapter {
  const view = (record: NotificationResetRecord): NotificationResetRecord => ({
    ...record,
    automation: record.pickup!.automation,
    pauseAttempted: record.pickup!.pauseAttempted,
    coordinatorArchiveAttempted: record.pickup!.coordinatorArchiveAttempted,
    coordinatorUpdateAttempted: record.pickup!.coordinatorUpdateAttempted,
    coordinatorReplaced: record.pickup!.coordinatorReplaced,
  });
  const retain = (record: NotificationResetRecord, child: NotificationResetRecord) => {
    record.pickup = {
      automation: child.automation,
      pauseAttempted: child.pauseAttempted,
      coordinatorArchiveAttempted: child.coordinatorArchiveAttempted,
      coordinatorUpdateAttempted: child.coordinatorUpdateAttempted,
      coordinatorReplaced: child.coordinatorReplaced,
    };
  };
  return {
    ...intake,
    snapshot: async () => {
      const primary = await intake.snapshot();
      const secondary = await pickupSnapshot();
      if (!secondary) return primary;
      return {
        ...primary,
        pickup: { automation: secondary.automation },
        resources: [
          ...new Map(
            [...primary.resources, ...secondary.resources].map((resource) => [
              resource.id,
              resource,
            ]),
          ).values(),
        ],
      };
    },
    pause: async (record, save) => {
      const first = await intake.pause(record, save);
      if (first.status !== 'done' || !record.pickup) return first;
      record.pauseAttempted = true;
      const child = view(record);
      record.pickup.pauseAttempted = true;
      await save(record);
      return pickup.pause(child, async (next) => {
        retain(record, next);
        await save(record);
      });
    },
    idle: async (record) => {
      const first = await intake.idle(record);
      return first.status === 'done' && record.pickup ? pickup.idle(view(record)) : first;
    },
    purge: async (record, resource) => {
      if (record.pickup) {
        const idle = await pickup.idle(view(record));
        if (idle.status !== 'done') return idle;
      }
      return intake.purge(record, resource);
    },
    coordinator: async (record, save) => {
      if (!record.coordinatorReplaced) {
        const first = await intake.coordinator(record, save);
        if (first.status !== 'done') return first;
        if (first.automation) record.automation = first.automation;
        record.coordinatorReplaced = true;
        await save(record);
      }
      if (record.pickup && !record.pickup.coordinatorReplaced) {
        const child = view(record);
        const second = await pickup.coordinator(child, async (next) => {
          retain(record, next);
          await save(record);
        });
        if (second.status !== 'done') return second;
        if (second.automation) child.automation = second.automation;
        child.coordinatorReplaced = true;
        retain(record, child);
        await save(record);
      }
      return { status: 'done' };
    },
    restore: async (record) => {
      const first = await intake.restore(record);
      return first.status === 'done' && record.pickup ? pickup.restore(view(record)) : first;
    },
  };
}
