import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

import stringWidth from 'fast-string-width';

import { createCliStyles } from '../cli/output.ts';
import {
  automationHistoryFixture,
  automationListFixtures,
  automationRunFixture,
  automationSyncFixture,
  captureAutomationPreview,
} from './automation-presentation-fixtures.ts';

describe('cli/automation presentation', () => {
  it('should distinguish desired state, observation and activity without additional service calls', async () => {
    const preview = await captureAutomationPreview('aligned');
    assert.deepEqual(preview.calls, ['list']);
    assert.equal(preview.exitCode, 0);
    assert.match(preview.stdout, /automation id +state +desired \/ observed \/ activity/u);
    assert.match(
      preview.stdout,
      /review +aligned +declared=yes +desired=enabled +applicable=yes +native=enabled/u,
    );
    assert.match(preview.stdout, /routing=isolated\s+execution=ok\s+delivery=not-requested/u);
    assert.match(preview.stdout, /one-shot +completed[\s\S]*native=disabled/u);
    assert.doesNotMatch(preview.stdout, /drift/u);
    assert.equal(preview.stdout.match(/^runtime +/gmu)?.length, 1);
    assert.equal(preview.stdout.match(/^workspace +/gmu)?.length, 1);
    assert.ok(preview.stdout.includes('/Workspace/Mixed'));
    assert.ok(!preview.stdout.trim().includes('\n\n\n'));
    assert.equal(preview.stderr, '');
  });

  it('should emphasize findings over intentional inactivity and retain each reason once', async () => {
    const styles = createCliStyles({ FORCE_COLOR: '3' });
    const attention = await captureAutomationPreview('attention', {
      environment: { FORCE_COLOR: '3' },
    });
    assert.equal(attention.exitCode, 1);
    assert.ok(attention.stdout.includes(styles.bold('paused-review')));
    assert.ok(attention.stdout.includes(styles.warning('drift')));
    assert.ok(attention.stdout.includes(styles.error('blocked')));
    const plain = stripVTControlCharacters(attention.stdout);
    assert.match(plain, /paused-review +drift +declared=yes +desired=disabled/u);
    assert.match(plain, /missing +drift[\s\S]*native=missing/u);
    assert.match(
      plain,
      /failed-review +warning[\s\S]*execution=error[\s\S]*delivery=not-delivered/u,
    );
    assert.ok(plain.includes('routing=persistent-pending'));
    for (const [id, code] of [
      ['missing', 'automation-missing'],
      ['paused-review', 'automation-drift'],
      ['safety-disabled', 'automation-native-safety-disabled'],
      ['scheduler', 'automation-scheduler-disabled'],
    ]) {
      assert.equal(plain.match(new RegExp(`Automation ${id}: ${code}`, 'gu'))?.length, 1);
    }
    const inactive = await captureAutomationPreview('inactive', {
      environment: { FORCE_COLOR: '3' },
    });
    assert.equal(inactive.exitCode, 0);
    for (const [id, state] of [
      ['paused-review', 'disabled'],
      ['codex-only', 'inapplicable'],
      ['retired', 'retained'],
    ]) {
      assert.ok(inactive.stdout.includes(styles.field(id!)));
      assert.ok(inactive.stdout.includes(styles.field(state!)));
    }
    assert.doesNotMatch(stripVTControlCharacters(inactive.stdout), /drift|blocked/u);
  });

  it('should distinguish unavailable observation from proven missing and show clear empty states', async () => {
    const unavailable = await captureAutomationPreview('unavailable');
    assert.equal(unavailable.exitCode, 1);
    assert.match(unavailable.stdout, /review +unavailable[\s\S]*native=unavailable/u);
    assert.doesNotMatch(unavailable.stdout, /native=missing/u);
    assert.match(unavailable.stdout, /operator +manual[\s\S]*automation-requires-operator-sync/u);
    const empty = await captureAutomationPreview('empty');
    assert.equal(empty.exitCode, 0);
    assert.match(empty.stdout, /no automations declared or retained/u);
    assert.match((await captureAutomationPreview('history-empty')).stdout, /no automation runs/u);
  });

  it('should retain sync outcomes, queued admission and history timestamps with pagination', async () => {
    const sync = await captureAutomationPreview('sync');
    assert.deepEqual(sync.calls, ['reconcile']);
    assert.match(sync.stdout, /review +updated[\s\S]*automation-synchronized/u);
    assert.ok(sync.stdout.includes('Thread-Mixed'));
    assert.match(sync.stderr, /warning[\s\S]*External-Mixed warning/u);
    const run = await captureAutomationPreview('run');
    assert.deepEqual(run.calls, ['run']);
    assert.match(
      run.stdout,
      /review +queued[\s\S]*native-id=Native-Mixed +run=Run-Mixed +execution=unavailable +delivery=unavailable/u,
    );
    assert.match(
      run.stderr,
      /info[\s\S]*accepted and queued[\s\S]*execution and delivery are unavailable/u,
    );
    assert.match(run.stdout, /automation +review  native-id=Native-Mixed/u);
    const history = await captureAutomationPreview('history');
    assert.deepEqual(history.calls, ['runs']);
    assert.ok(history.stdout.includes('total=3  offset=0  limit=2'));
    assert.match(history.stdout, /next-offset +2/u);
    assert.match(
      history.stdout,
      /review +error +run=Run-Mixed +ts=1790812800000 +execution=error +delivery=not-delivered/u,
    );
    assert.match(history.stdout, /ts=1790812800001 +execution=unavailable/u);
  });

  it('should keep one severity-sorted message section after output and preserve bounded failures', async () => {
    const skipped = await captureAutomationPreview('skipped', { notices: true });
    assert.equal(skipped.exitCode, 1);
    assert.equal(skipped.events.at(-1)?.stream, 'stderr');
    assert.ok(skipped.events.slice(0, -1).every(({ stream }) => stream === 'stdout'));
    assert.equal(skipped.stderr.match(/messages/gu)?.length, 1);
    assert.match(
      skipped.stderr,
      /error[\s\S]*automation run was invalid-spec[\s\S]*review the automation specification[\s\S]*warning[\s\S]*MixedCaseWarning[\s\S]*info[\s\S]*MixedCaseInfo/u,
    );
    assert.match(skipped.stdout, /reason=invalid-spec/u);
    const disabled = await captureAutomationPreview('disabled');
    assert.equal(disabled.exitCode, 1);
    assert.match(disabled.stdout, /reason=disabled/u);
    assert.match(disabled.stderr, /enable the automation before requesting another run/u);
    const failure = await captureAutomationPreview('failure', { notices: true });
    assert.equal(failure.exitCode, 1);
    assert.equal(failure.stdout, '');
    assert.equal(failure.stderr.match(/messages/gu)?.length, 1);
    assert.match(failure.stderr, /automation-gateway-unavailable/u);
    assert.match(failure.stderr, /check automation configuration and runtime availability/u);
  });

  it('should preserve exact literal content and width in wide, narrow, colored and plain previews', async () => {
    for (const name of [
      'aligned',
      'attention',
      'inactive',
      'unavailable',
      'sync',
      'run',
      'skipped',
      'disabled',
      'history',
      'empty',
      'failure',
    ]) {
      for (const columns of [32, 160]) {
        const plain = await captureAutomationPreview(name, {
          columns,
          notices: true,
          environment: { NO_COLOR: '1', FORCE_COLOR: '3' },
        });
        const color = await captureAutomationPreview(name, {
          columns,
          notices: true,
          environment: { FORCE_COLOR: '3' },
        });
        assert.equal(stripVTControlCharacters(color.stdout), plain.stdout);
        assert.equal(stripVTControlCharacters(color.stderr), plain.stderr);
        for (const text of [plain.stdout, plain.stderr])
          assert.ok(
            text.split('\n').every((line) => stringWidth(line) <= columns),
            `${name}: ${columns}`,
          );
        const wide = await captureAutomationPreview(name, { columns: 160, notices: true });
        const compact = (value: string) => value.replace(/\s/gu, '');
        assert.equal(compact(plain.stdout), compact(wide.stdout));
        assert.equal(compact(plain.stderr), compact(wide.stderr));
      }
    }
  });

  it('should leave json values and exit codes unchanged across the command fixtures', async () => {
    const fixtures = {
      ...automationListFixtures,
      sync: { runtime: 'openclaw', status: 'synchronized', ...automationSyncFixture },
      run: automationRunFixture,
      history: automationHistoryFixture,
      failure: { status: 'failed', code: 'automation-gateway-unavailable' },
    };
    for (const [name, result] of Object.entries(fixtures)) {
      const machine = await captureAutomationPreview(name, {
        json: true,
        environment: { FORCE_COLOR: '3' },
      });
      assert.deepEqual(JSON.parse(machine.stdout), result);
      assert.equal(stripVTControlCharacters(machine.stdout), machine.stdout);
      assert.doesNotMatch(machine.stderr, /messages/u);
      assert.ok(!machine.stderr.includes('\u001b'));
      assert.equal(machine.exitCode, (await captureAutomationPreview(name)).exitCode);
      assert.equal(machine.events[0]?.stream, 'stdout');
    }
  });
});
