import {
  captureStatusFixture,
  statusFixtureNames,
} from '../test/github-notification-status-fixtures.ts';

// fixture-backed previews never read live agent or notification state.
const columns = process.argv.includes('--narrow') ? 40 : 120;
const color = process.argv.includes('--color');
for (const name of statusFixtureNames) {
  process.stdout.write(
    `\nillustrative notification status fixture: ${name} (${columns} columns)\n`,
  );
  const { events, exitCode } = await captureStatusFixture(name, { columns, color });
  for (const { stream, text } of events) {
    process.stdout.write(`[${stream}]\n${text}`);
  }
  process.stdout.write(`[exit ${exitCode}]\n`);
}
