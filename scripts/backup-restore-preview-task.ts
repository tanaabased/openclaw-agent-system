import {
  captureRestoreFixture,
  restoreFixtures,
  type RestoreFixtureName,
} from '../test/cli-backup-restore-fixtures.ts';

// fixture-backed previews do not touch archives, live agents, or host state.
const columns = process.argv.includes('--narrow') ? 40 : 120;
const color = process.argv.includes('--color');
for (const name of Object.keys(restoreFixtures) as RestoreFixtureName[]) {
  process.stdout.write(`\nillustrative restore fixture: ${name} (${columns} columns)\n`);
  const { events } = await captureRestoreFixture(name, { columns, color });
  for (const { text } of events) process.stdout.write(text);
}
