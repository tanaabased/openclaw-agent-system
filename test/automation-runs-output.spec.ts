import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { captureAutomationRuns } from './automation-runs-presentation-fixtures.ts';

describe('cli/automation-runs', () => {
  it('should match illustrative narrow and filtered-empty command previews', async () => {
    const previews = ['illustrative fixture data; no host operations\n'];
    for (const [name, options] of [
      ['narrow page', { columns: 34 }],
      ['filtered empty', { columns: 80, empty: true }],
    ] as const) {
      const events = await captureAutomationRuns(options);
      previews.push(
        `## ${name}\n${events.map(({ stream, text }) => `[${stream}]\n${text}`).join('')}`,
      );
    }
    assert.equal(
      previews.join('\n'),
      await readFile(new URL('./automation-runs-command-previews.txt', import.meta.url), 'utf8'),
    );
  });

  it('should preserve query context, mixed outcomes, and exact timestamps in no-color output', async () => {
    const events = await captureAutomationRuns({ columns: 80 });
    const primary = events
      .filter(({ stream }) => stream === 'stdout')
      .map(({ text }) => text)
      .join('');
    assert.match(primary, /automation +review/u);
    assert.match(primary, /query +limit=2 +offset=2/u);
    assert.match(primary, /run-id=all/u);
    assert.match(primary, /run-older +2026-10-/u);
    assert.match(primary, /execution +delivery/u);
    assert.match(primary, /run-current/u);
    assert.match(primary, /next page: --offset 4/u);
    assert.ok(!primary.includes('no matching runs'));
    assert.deepEqual(
      events.filter(({ stream }) => stream === 'stderr'),
      [],
    );
  });

  it('should show the requested run filter and omit pagination hints for empty results', async () => {
    const events = await captureAutomationRuns({ columns: 80, empty: true });
    const primary = events.map(({ text }) => text).join('');
    assert.match(primary, /run-id=run-missing/u);
    assert.match(primary, /no matching runs/u);
    assert.ok(!primary.includes('next page:'));
  });
});
