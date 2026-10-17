import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';

export const lockOptions = {
  retries: { factor: 1, maxTimeout: 0, minTimeout: 0, retries: 0 },
  staleMs: 30_000,
};

export async function controlledFileLock() {
  let compromise!: (error: Error) => void;
  let releases = 0;
  const handle = await acquirePrivateStateFileLock('/synthetic/private-state', lockOptions, {
    async lock(_path, options) {
      compromise = options.onCompromised;
      return async () => {
        releases += 1;
      };
    },
  });
  return {
    handle,
    compromise: () =>
      compromise(Object.assign(new Error('/private/path must not leak'), { code: 'ECOMPROMISED' })),
    releases: () => releases,
  };
}
