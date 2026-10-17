import {
  captureSyncFixture,
  syncFixtureNames,
} from '../test/automation-sync-presentation-fixtures.ts';

// illustrative fixtures never contact a gateway or read host automation state.
const columns = process.argv.includes('--narrow') ? 40 : 120;
const color = process.argv.includes('--color');
for (const name of syncFixtureNames) {
  process.stdout.write(`\nillustrative automation sync fixture: ${name} (${columns} columns)\n`);
  const { events, exitCode } = await captureSyncFixture(name, {
    columns,
    color,
    warnings: name === 'partial-failure',
  });
  for (const { stream, text } of events) process.stdout.write(`[${stream}]\n${text}`);
  process.stdout.write(`[exit ${exitCode}]\n`);
}
