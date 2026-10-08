import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import { backupPreviewPlan, captureBackupCommand } from './backup-presentation-fixtures.ts';

const stdout = (events: Awaited<ReturnType<typeof captureBackupCommand>>['events']) =>
  events
    .filter(({ stream }) => stream === 'stdout')
    .map(({ text }) => text)
    .join('');

describe('cli/backup-create', () => {
  it('should match illustrative wide narrow and creation command previews', async () => {
    const previews = ['illustrative fixture data; no host operations\n'];
    for (const [name, options] of [
      ['wide preview', { columns: 100 }],
      ['narrow preview', { columns: 40 }],
      ['created', { columns: 100, dryRun: false }],
    ] as const) {
      const { events } = await captureBackupCommand(options);
      previews.push(
        `## ${name}\n${events.map(({ stream, text }) => `[${stream}]\n${text}`).join('')}`,
      );
    }
    assert.equal(
      previews.join('\n'),
      await readFile(new URL('./backup-command-previews.txt', import.meta.url), 'utf8'),
    );
  });

  it('should show effective selection and bounded reasons before one trailing diagnostic section', async () => {
    const { events, exitCode } = await captureBackupCommand();
    const primary = stdout(events);
    assert.equal(exitCode, 0);
    assert.match(primary, /output +\/Archives\/Backup/u);
    assert.match(primary, /entries +2/u);
    assert.match(primary, /gitignore +on; includes override ignores/u);
    assert.match(primary, /include +MEMORY.md, Memory\/\*\*, Missing-\*\.md/u);
    assert.match(primary, /exclude +Scratch\/\*\*/u);
    assert.match(primary, /selected +MEMORY.md\nselected +Memory\/Day.md/u);
    assert.match(primary, /excluded +exclude: 1 observed filter decisions; 1 directories pruned/u);
    assert.match(primary, /pruned +exclude: Scratch/u);
    assert.match(primary, /agent database pending capture \(not yet included\)/u);
    assert.match(primary, /\n\nworkspace {2}\/Workspace\/Mixed\n\n$/u);
    assert.equal(events.at(-1)?.stream, 'stderr');
    assert.ok(events.slice(0, -1).every(({ stream }) => stream === 'stdout'));
    const diagnostic = events.at(-1)!.text;
    assert.equal(diagnostic.match(/messages/gu)?.length, 1);
    assert.match(
      diagnostic,
      /include pattern matched no observed workspace entries \(Missing-\*\.md\)/u,
    );
  });

  it('should emphasize selected labels and paths without coloring success or coverage prose', async () => {
    for (const dryRun of [true, false]) {
      const plain = await captureBackupCommand({ dryRun });
      const colored = await captureBackupCommand({ dryRun, environment: { FORCE_COLOR: '3' } });
      assert.deepEqual(
        colored.events.map(({ stream, text }) => ({ stream, text: ansis.strip(text) })),
        plain.events,
      );
      const primary = stdout(colored.events);
      assert.ok(primary.includes('\u001b[38;2;0;200;138mselected\u001b[39m'));
      assert.ok(primary.includes('\u001b[38;2;0;200;138mMEMORY.md\u001b[39m'));
      assert.ok(primary.includes(dryRun ? 'preview' : 'created and verified'));
      assert.match(primary, /workspace selected; agent database (pending|absent)/u);
      assert.ok(primary.includes('\u001b[2mexclude: 1 observed'));
    }
    const forced = await captureBackupCommand({ environment: { NO_COLOR: '', FORCE_COLOR: '3' } });
    assert.ok(forced.events.every(({ text }) => !text.includes('\u001b')));
  });

  it('should preserve literal tokens when narrow and distinguish all coverage states', async () => {
    for (const columns of [12, 40, 100]) {
      const { events } = await captureBackupCommand({ columns });
      const primary = stdout(events);
      const table = primary.split('\n').slice(0, -3);
      assert.ok(table.every((line) => stringWidth(line) <= columns));
      for (const token of ['MEMORY.md', 'Memory/Day.md', '/Archives/Backup', 'Missing-*.md'])
        assert.ok(primary.replace(/\s/gu, '').includes(token));
    }
    for (const state of ['captured', 'absent', 'off'] as const) {
      const { events } = await captureBackupCommand({ dryRun: false, state });
      assert.ok(stdout(events).includes(`agent database ${state}`));
      assert.match(stdout(events), /entries +3/u);
      assert.match(stdout(events), /selected +Later.md/u);
      assert.match(stdout(events), /pruned +exclude: Refreshed/u);
      assert.ok(!stdout(events).includes('exclude: Scratch'));
    }
  });

  it('should retain exact machine keys and meanings on preview creation zero matches and failure', async () => {
    for (const empty of [false, true]) {
      for (const dryRun of [true, false]) {
        const { events, exitCode } = await captureBackupCommand({
          dryRun,
          empty,
          json: true,
          environment: { FORCE_COLOR: '3' },
        });
        assert.equal(exitCode, 0);
        const result = JSON.parse(stdout(events));
        assert.equal(result.status, dryRun ? 'preview' : 'created');
        assert.equal('selection' in result, false);
        assert.deepEqual(
          Object.keys(result).sort(),
          (dryRun
            ? ['status', 'agentId', 'workspaceDir', 'settings', 'coverage', 'files', 'diagnostics']
            : [
                'status',
                'archive',
                'format',
                'version',
                'agentId',
                'capturedAt',
                'settings',
                'coverage',
                'inventory',
                'diagnostics',
              ]
          ).sort(),
        );
        assert.deepEqual(result.settings, backupPreviewPlan.settings);
        assert.deepEqual(result.diagnostics, backupPreviewPlan.diagnostics);
        assert.equal((dryRun ? result.files : result.inventory).length, empty ? 0 : dryRun ? 2 : 3);
        assert.equal(result.coverage.openclawState, dryRun ? 'pending' : 'absent');
        assert.ok(events.every(({ text }) => !text.includes('\u001b')));
        assert.equal(
          events.at(-1)!.text,
          'backup-include-unmatched: An include pattern matched no workspace entries. (Missing-*.md)\n',
        );
      }
    }
    const empty = await captureBackupCommand({ empty: true });
    assert.match(stdout(empty.events), /entries +0/u);
    assert.ok(!stdout(empty.events).includes('selected  '));
    for (const json of [false, true]) {
      const failed = await captureBackupCommand({ dryRun: false, fail: true, json });
      assert.equal(failed.exitCode, 1);
      if (json) assert.equal(JSON.parse(stdout(failed.events)).status, 'failed');
      else
        assert.match(
          failed.events.at(-1)!.text,
          /messages[\s\S]*error[\s\S]*External-Mixed failure/u,
        );
    }
  });
});
