import { captureAutomationPreview } from '../test/automation-presentation-fixtures.ts';

process.stdout.write('illustrative fixture data; no gateway or host operations\n');
for (const name of [
  'aligned',
  'attention',
  'inactive',
  'empty',
  'unavailable',
  'sync',
  'run',
  'skipped',
  'history',
  'history-empty',
  'failure',
]) {
  process.stdout.write(`\n## ${name}\n`);
  const { events } = await captureAutomationPreview(name);
  for (const { stream, text } of events) process.stdout.write(`[${stream}]\n${text}`);
}
