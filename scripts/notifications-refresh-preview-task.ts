import {
  captureRefreshFixture,
  refreshFixtureNames,
} from '../test/notifications-refresh-presentation-fixtures.ts';

// illustrative fixtures never contact providers or read host notification state.
const columns = process.argv.includes('--narrow') ? 40 : 120;
const color = process.argv.includes('--color');
for (const name of refreshFixtureNames) {
  process.stdout.write(
    `\nillustrative notification refresh fixture: ${name} (${columns} columns)\n`,
  );
  const { events, exitCode } = await captureRefreshFixture(name, {
    columns,
    color,
    warnings: name === 'partial-failure',
  });
  for (const { stream, text } of events) process.stdout.write(`[${stream}]\n${text}`);
  process.stdout.write(`[exit ${exitCode}]\n`);
}
