import { stat, utimes } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const [marker, lock] = process.argv.slice(2);
const deadline = Date.now() + 45_000;
while (!(await stat(marker).catch(() => undefined))) {
  if (Date.now() >= deadline) throw new Error('Git preparation did not reach the paused boundary.');
  await setTimeout(100);
}
await utimes(lock, new Date(0), new Date(0));
