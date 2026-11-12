import feedbackDiscoveryOwner from './tasks/feedback/feedback-discovery-owner.ts';

/** compare-and-save each observation without replacing concurrently advanced workflow state. */
export default async function discoveryCheckpoint<R extends { id: string; feedback?: F }, F>(
  store: {
    exclusive<T>(
      run: (state: { records: R[] }, save: () => Promise<void>) => Promise<T>,
      waitForLock?: boolean,
      operation?: 'delivery-checkpoint',
      signal?: AbortSignal,
    ): Promise<T>;
  },
  scan: { id: string; before: string; feedback: F },
  assertCurrent?: () => Promise<void>,
  waitForLock = true,
) {
  await store.exclusive(
    async (state, save) => {
      await assertCurrent?.();
      const record = state.records.find((entry) => entry.id === scan.id);
      if (!record || feedbackDiscoveryOwner(record) !== scan.before)
        throw new Error('discovery-checkpoint-changed');
      record.feedback = structuredClone(scan.feedback);
      await save();
    },
    waitForLock,
    'delivery-checkpoint',
  );
}
