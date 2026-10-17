import { captureWaitPreview } from '../test/notifications-wait-presentation-fixtures.ts';

// fixture-backed previews do not contact GitHub or read host state.
process.stdout.write('illustrative fixture data; no provider operations\n');
for (const name of [
  'baseline-success',
  'item-success',
  'timeout',
  'degraded',
  'invalid-options',
] as const) {
  process.stdout.write(`\n## ${name}\n`);
  const { events } = await captureWaitPreview(name);
  for (const { stream, text } of events) process.stdout.write(`[${stream}]\n${text}`);
}
