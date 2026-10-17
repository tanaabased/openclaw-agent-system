import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

import stringWidth from 'fast-string-width';

import { createCliStyles } from '../cli/output.ts';
import {
  capturePrunePreview,
  deferredArchive,
  partialPruneFixture,
  pruneDestination,
  pruneFailure,
  pruneFixture,
  removedArchive,
  retainedArchive,
  skippedArchives,
} from './backup-prune-presentation-fixtures.ts';

describe('cli/backup-prune presentation', () => {
  it('should distinguish preview from applied removals with counted compact groups', async () => {
    for (const dryRun of [true, false]) {
      const result = dryRun
        ? pruneFixture
        : { ...pruneFixture, deleted: pruneFixture.wouldDelete, wouldDelete: [] };
      const preview = await capturePrunePreview({ result, dryRun });
      assert.equal(preview.exitCode, 0);
      assert.equal(preview.pruneInput?.dryRun, dryRun);
      assert.equal(preview.pruneInput?.keep, 1);
      assert.equal(preview.pruneInput?.output, pruneDestination);
      assert.match(preview.stdout, new RegExp(`mode +${dryRun ? 'preview' : 'applied'}\\n`, 'u'));
      assert.match(preview.stdout, /kept \(1\)/u);
      assert.match(preview.stdout, dryRun ? /would-delete \(2\)/u : /deleted \(2\)/u);
      assert.match(preview.stdout, dryRun ? /deleted \(0\) +none/u : /would-delete \(0\) +none/u);
      assert.match(preview.stdout, /skipped \(6\)/u);
      for (const literal of [
        pruneFixture.agentId,
        pruneDestination,
        retainedArchive,
        removedArchive,
        deferredArchive,
      ]) {
        assert.ok(preview.stdout.includes(literal), literal);
      }
      assert.match(preview.stdout, /keep +1\n/u);
      assert.equal(preview.stdout.match(/^agent +/gmu)?.length, 1);
      assert.equal(preview.stdout.match(/^output +/gmu)?.length, 1);
      assert.equal(preview.stdout.match(/^mode +/gmu)?.length, 1);
      assert.ok(preview.stdout.startsWith('\n') && preview.stdout.endsWith('\n\n'));
      assert.ok(!preview.stdout.trim().includes('\n\n'));
    }
  });

  it('should show zero candidates and below, equal and above retention boundaries', async () => {
    const archives = [retainedArchive, removedArchive, deferredArchive];
    for (const count of [0, 1, 2, 3]) {
      const result = {
        ...pruneFixture,
        keep: 2,
        kept: archives.slice(0, Math.min(count, 2)),
        wouldDelete: archives.slice(2, count),
        skipped: [],
      };
      const preview = await capturePrunePreview({ result });
      assert.match(preview.stdout, new RegExp(`kept \\(${Math.min(count, 2)}\\)`, 'u'));
      assert.match(preview.stdout, new RegExp(`would-delete \\(${count > 2 ? 1 : 0}\\)`, 'u'));
      assert.match(preview.stdout, /deleted \(0\) +none/u);
      assert.match(preview.stdout, /skipped \(0\) +none/u);
      if (!count) assert.match(preview.stdout, /kept \(0\) +none/u);
    }
  });

  it('should dim retained and intentional skips without styling preview as success', async () => {
    const environment = { FORCE_COLOR: '3' };
    const styles = createCliStyles(environment);
    const preview = await capturePrunePreview({ environment });
    assert.ok(preview.stdout.includes(styles.field(retainedArchive)));
    for (const { path, reason } of skippedArchives.slice(0, 4)) {
      assert.ok(preview.stdout.includes(styles.field(`${path} (${reason})`)));
    }
    for (const { reason } of skippedArchives.slice(4)) {
      assert.ok(preview.stdout.includes(styles.warning(reason)));
    }
    assert.ok(preview.stdout.includes(styles.action('would-delete (2)')));
    assert.ok(preview.stdout.includes(styles.action('mode')));
    assert.ok(!preview.stdout.includes(styles.status('backup')));
    assert.ok(!preview.stdout.includes(styles.status('mode')));
    const applied = await capturePrunePreview({
      environment,
      dryRun: false,
      result: { ...pruneFixture, deleted: pruneFixture.wouldDelete, wouldDelete: [] },
    });
    assert.ok(applied.stdout.includes(styles.action('deleted (2)')));
    assert.ok(applied.stdout.includes(styles.status('mode')));
  });

  it('should retain context and all partial progress before one severity-sorted diagnostics section', async () => {
    const preview = await capturePrunePreview({
      result: partialPruneFixture,
      failure: true,
      dryRun: false,
      notices: [
        { severity: 'notice', message: 'MixedCaseInfo' },
        { severity: 'warning', message: 'MixedCaseWarning' },
      ],
    });
    assert.equal(preview.exitCode, 1);
    assert.match(preview.stdout, /mode +apply stopped/u);
    assert.match(preview.stdout, /prune failed \(backup-prune-delete-failed\)/u);
    assert.match(
      preview.stdout,
      /kept \(1\)[\s\S]*would-delete \(1\)[\s\S]*deleted \(1\)[\s\S]*skipped \(6\)/u,
    );
    for (const literal of [
      pruneFixture.agentId,
      pruneDestination,
      retainedArchive,
      removedArchive,
      deferredArchive,
      ...skippedArchives.map(({ path }) => path),
    ]) {
      assert.ok(preview.stdout.includes(literal), literal);
    }
    assert.equal(preview.events.at(-1)?.stream, 'stderr');
    assert.ok(preview.events.slice(0, -1).every(({ stream }) => stream === 'stdout'));
    assert.equal(preview.stderr.match(/messages/gu)?.length, 1);
    assert.ok(preview.stderr.includes(pruneFailure.message));
    assert.match(
      preview.stderr,
      /error[\s\S]*MixedCaseError[\s\S]*warning[\s\S]*MixedCaseWarning[\s\S]*info[\s\S]*MixedCaseInfo/u,
    );
  });

  it('should preserve content and literal casing across colored, plain, wide and narrow previews', async () => {
    for (const terminalColumns of [32, 120]) {
      const options = {
        terminalColumns,
        result: partialPruneFixture,
        failure: true,
        dryRun: false,
      };
      const plain = await capturePrunePreview({
        ...options,
        environment: { NO_COLOR: '1', FORCE_COLOR: '3' },
      });
      const colored = await capturePrunePreview({ ...options, environment: { FORCE_COLOR: '3' } });
      assert.equal(stripVTControlCharacters(colored.stdout), plain.stdout);
      assert.equal(stripVTControlCharacters(colored.stderr), plain.stderr);
      assert.ok(plain.stdout.split('\n').every((line) => stringWidth(line) <= terminalColumns));
      assert.ok(plain.stderr.split('\n').every((line) => stringWidth(line) <= terminalColumns));
      const content = plain.stdout.replace(/\s/gu, '');
      for (const literal of [
        pruneFixture.agentId,
        pruneDestination,
        ...skippedArchives.map(({ reason }) => reason),
        retainedArchive,
        removedArchive,
        deferredArchive,
      ]) {
        assert.ok(content.includes(literal), literal);
      }
      assert.ok(
        plain.stderr.replace(/\s/gu, '').includes(pruneFailure.message.replace(/\s/gu, '')),
      );
    }
  });

  it('should preserve exact json results and exit behavior without human formatting', async () => {
    for (const scenario of [
      { result: pruneFixture, dryRun: true, failure: false, status: 'preview' },
      {
        result: { ...pruneFixture, deleted: pruneFixture.wouldDelete, wouldDelete: [] },
        dryRun: false,
        failure: false,
        status: 'pruned',
      },
      { result: partialPruneFixture, dryRun: false, failure: true, status: 'failed' },
    ]) {
      const preview = await capturePrunePreview({
        ...scenario,
        json: true,
        environment: { FORCE_COLOR: '3' },
      });
      assert.deepEqual(JSON.parse(preview.stdout), {
        status: scenario.status,
        ...scenario.result,
        ...(scenario.failure ? { diagnostics: [pruneFailure] } : {}),
      });
      assert.equal(preview.exitCode, scenario.failure ? 1 : 0);
      assert.equal(preview.stderr, scenario.failure ? `${pruneFailure.message}\n` : '');
      assert.equal(stripVTControlCharacters(preview.stdout), preview.stdout);
      assert.equal(preview.events[0]?.stream, 'stdout');
    }
  });
});
