import { existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const path = process.argv[2];
if (!path) throw new Error('reload-marker-path-required');
const deadline = performance.now() + 45_000;
while (!existsSync(path)) {
  if (performance.now() >= deadline) throw new Error('controlled-gateway-reload-did-not-start');
  await setTimeout(100);
}
