import assert from 'node:assert/strict';

import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import {
  captureRestoreFixture,
  restoreFixturePaths,
  restoreFixtures,
  type RestoreFixtureName,
} from './cli-backup-restore-fixtures.ts';

const names = Object.keys(restoreFixtures) as RestoreFixtureName[];

describe('cli/backup-restore', () => {
  it('should show exact staging destinations without implying live activation', async () => {
    const { calls, events, exitCode } = await captureRestoreFixture('captured');
    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      [restoreFixturePaths.archive, restoreFixturePaths.target, 'Agent-MixedCase'],
    ]);
    const text = events[0]!.text;
    assert.match(text, /staged/u);
    assert.match(text, /not activated/u);
    for (const path of Object.values(restoreFixturePaths)) assert.ok(text.includes(path));
    assert.match(text, /agent\s+Agent-MixedCase/u);
    assert.ok(text.startsWith('\n') && text.endsWith('\n\n'));
  });

  it('should dim intentional exclusions and warn about reduced coverage without repeated database explanations', async () => {
    for (const name of ['captured', 'absent', 'omissions', 'degraded', 'legacy'] as const) {
      const { events } = await captureRestoreFixture(name, { color: true, columns: 200 });
      const text = events.map(({ text }) => ansis.strip(text)).join('');
      assert.match(text, /protected path\s+\/Protected\/AgentKey/u);
      assert.match(text, /capture scope/u);
      assert.match(text, /non-atomic capture/u);
      assert.ok(events[0]!.text.includes('\u001b[2m/Protected/AgentKey\u001b[22m'));
      assert.ok(events[0]!.text.includes('\u001b[33mnon-atomic capture'));
      if (name === 'omissions') {
        assert.match(text, /database disabled/u);
        assert.equal(text.match(/explicitly excluded/gu)?.length, 1);
        assert.ok(events[0]!.text.includes('\u001b[2mdatabase disabled\u001b[22m'));
      }
      if (name === 'absent') {
        assert.match(text, /database absent/u);
        assert.equal(text.match(/did not exist/gu)?.length, 1);
        assert.ok(events[0]!.text.includes('\u001b[33mdatabase absent'));
      }
      if (name === 'captured') assert.match(text, /transient rows/u);
      if (name === 'legacy') assert.match(text, /database unsupported/u);
      if (name === 'degraded') {
        assert.match(text, /limitation\s+External CaptureLimit: MemoryStore unavailable\./u);
        assert.ok(events[0]!.text.includes('\u001b[33mlimitation'));
        assert.deepEqual(
          events.map(({ stream }) => stream),
          ['stdout', 'stderr'],
        );
        assert.match(events[1]!.text, /warning[\s\S]*No Match for Optional\.md\./u);
        assert.equal(text.match(/No Match for Optional\.md\./gu)?.length, 1);
        assert.equal(text.match(/CaptureError: unreadable entry\./gu)?.length, 1);
        assert.ok(!events[0]!.text.includes('CaptureError'));
      }
    }
  });

  it('should preserve json fields, raw omissions, diagnostic streams and exit behavior', async () => {
    for (const name of names) {
      const { events, manifest, exitCode } = await captureRestoreFixture(name, {
        json: true,
        color: true,
      });
      const result = JSON.parse(events[0]!.text);
      assert.ok(events.every(({ text }) => !text.includes('\u001b')));
      assert.ok(events.every(({ text }) => !text.includes('messages')));
      if (name === 'failed' || name === 'rejected') {
        assert.equal(exitCode, 1);
        assert.deepEqual(result, {
          status: 'failed',
          diagnostics: [
            {
              code: name === 'failed' ? 'backup-target-nonempty' : 'backup-restore-operator-only',
              message:
                name === 'failed'
                  ? 'The restore target must be empty.'
                  : 'Backup restore is available only to an operator outside an agent or setup command.',
            },
          ],
        });
        assert.equal(events[1]!.text, `${result.diagnostics[0]!.message}\n`);
        continue;
      }
      assert.equal(exitCode, 0);
      assert.deepEqual(result, {
        status: 'restored',
        archive: restoreFixturePaths.archive,
        target: restoreFixturePaths.target,
        agentId: manifest.agentId,
        workspace: restoreFixturePaths.workspace,
        ...(manifest.coverage.openclawState === 'captured'
          ? { database: restoreFixturePaths.database }
          : {}),
        coverage: manifest.coverage,
        omitted: [
          ...manifest.coverage.omittedPaths,
          ...manifest.coverage.limitations,
          ...(manifest.coverage.openclawState === 'captured'
            ? []
            : [`OpenClaw agent database: ${manifest.coverage.openclawState}.`]),
        ],
      });
      if (name === 'degraded')
        assert.equal(
          events[1]!.text,
          'backup-include-unmatched: No Match for Optional.md. (Optional.md)\nbackup-capture-warning: CaptureError: unreadable entry.\n',
        );
      else assert.equal(events.length, 1);
    }
  });

  it('should reject bound callers and missing targets before restoring and keep errors after primary output', async () => {
    for (const name of ['rejected', 'failed'] as const) {
      const { calls, events, exitCode } = await captureRestoreFixture(name);
      assert.equal(exitCode, 1);
      if (name === 'rejected') assert.deepEqual(calls, []);
      assert.deepEqual(
        events.map(({ stream }) => stream),
        ['stdout', 'stderr'],
      );
      assert.match(events[0]!.text, /failed \(backup-/u);
      assert.equal(events[1]!.text.match(/messages/gu)?.length, 1);
      assert.match(events[1]!.text, /error/u);
    }
    const { calls, events, exitCode } = await captureRestoreFixture('captured', { target: '' });
    assert.deepEqual(calls, []);
    assert.equal(exitCode, 1);
    assert.match(events[0]!.text, /backup-target-required/u);
  });

  it('should keep wide and narrow color previews equivalent and preserve literal data through wrapping', async () => {
    for (const name of names) {
      for (const columns of [40, 120]) {
        const plain = await captureRestoreFixture(name, { columns });
        const colored = await captureRestoreFixture(name, { columns, color: true });
        assert.deepEqual(
          colored.events.map(({ stream, text }) => ({ stream, text: ansis.strip(text) })),
          plain.events,
        );
        for (const { text } of plain.events)
          assert.ok(text.split('\n').every((line) => stringWidth(line) <= columns));
        if (name !== 'rejected' && name !== 'failed') {
          const compact = plain.events[0]!.text.replace(/\s/gu, '');
          assert.ok(compact.includes(restoreFixturePaths.archive));
          assert.ok(compact.includes(restoreFixturePaths.workspace));
        }
      }
    }
  });
});
