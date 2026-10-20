import {
  captureUnsetPreview,
  unsetFixtures,
  type UnsetPreview,
} from '../test/credentials-unset-presentation-fixtures.ts';

process.stdout.write('illustrative fixture data; no credential or gateway operations\n');
for (const terminalColumns of [120, 32]) {
  for (const name of Object.keys(unsetFixtures) as UnsetPreview[]) {
    process.stdout.write(`\n## ${name} (${terminalColumns} columns)\n`);
    const { events } = await captureUnsetPreview(name, { terminalColumns });
    for (const { stream, text } of events) process.stdout.write(`[${stream}]\n${text}`);
  }
}
