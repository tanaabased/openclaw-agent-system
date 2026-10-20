import { automationHash } from './automation-hash.ts';

/** compare-and-save each observation without replacing concurrently advanced workflow state. */
export default async function discoveryCheckpoint<R extends { id: string; feedback?: F }, F>(
  store: {
    exclusive<T>(
      run: (state: { records: R[] }, save: () => Promise<void>) => Promise<T>,
    ): Promise<T>;
  },
  scan: { id: string; before: string; feedback: F },
  assertCurrent?: () => Promise<void>,
) {
  await store.exclusive(async (state, save) => {
    await assertCurrent?.();
    const record = state.records.find((entry) => entry.id === scan.id);
    if (!record || automationHash(record) !== scan.before)
      throw new Error('discovery-checkpoint-changed');
    record.feedback = structuredClone(scan.feedback);
    await save();
  });
}
