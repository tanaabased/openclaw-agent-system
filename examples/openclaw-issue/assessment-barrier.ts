import { existsSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const filesystem = {
  exists: (path: string) => existsSync(path),
  observe(directory: string, changed: () => void, failed: (error: Error) => void) {
    const watcher = watch(directory, changed);
    watcher.on('error', failed);
    return () => watcher.close();
  },
};

/** only the isolated scenario creates this barrier; native state, never prose, releases it. */
export default async function waitForAssessmentRelease(
  id: string,
  directory = tmpdir(),
  boundary = filesystem,
) {
  const held = join(directory, 'notification-assessments-held');
  const released = join(directory, `notification-assessment-released-${id}`);
  if (!boundary.exists(held) || boundary.exists(released)) return;
  await new Promise<void>((resolve, reject) => {
    const close = boundary.observe(
      directory,
      () => {
        if (boundary.exists(released)) finish();
      },
      (error) => finish(error),
    );
    const timeout = setTimeout(
      () => finish(new Error('notification-assessment-barrier-timeout')),
      300000,
    );
    function finish(error?: Error) {
      clearTimeout(timeout);
      close();
      if (error) reject(error);
      else resolve();
    }
    if (boundary.exists(released)) finish();
  });
}
