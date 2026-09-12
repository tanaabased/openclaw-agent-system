import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';

import lockfile from 'proper-lockfile';

/** Read one atomically published snapshot of the disposable provider. */
export function readFixtureState(path) {
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.fixture !== 'operator-access-ci') throw new Error('Unprepared GitHub fixture');
  return state;
}

/** Serialize fixture mutations and publish complete JSON for concurrent readers. */
export async function updateFixtureState(path, update) {
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 200, factor: 1, minTimeout: 25, maxTimeout: 25 },
    stale: 30_000,
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const state = readFixtureState(path);
    const result = await update(state);
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, path);
    return result;
  } finally {
    try {
      await rm(temporary, { force: true });
    } finally {
      await release();
    }
  }
}
