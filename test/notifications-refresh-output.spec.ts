import assert from 'node:assert/strict';
import ansis from 'ansis';
import stringWidth from 'fast-string-width';
import {
  captureRefreshFixture,
  refreshFixtureNames,
  refreshFixtureRepository,
} from './notifications-refresh-presentation-fixtures.ts';

import { cliDiagnosticContext } from '../core/cli-diagnostic-context.ts';
describe('channels/github/cli/refresh presentation', () => {
  it('should show the native queue receipt without claiming a completed scan', async () => {
    const result = await captureRefreshFixture('queued');
    assert.equal(result.exitCode, 0);
    assert.match(result.events[0]!.text, /status\s+queued/u);
    assert.match(result.events[0]!.text, /run\s+NativeRun-MixedCase/u);
    assert.match(result.events[0]!.text, /timeout\s+300s \(default\)/u);
    assert.ok(!result.events[0]!.text.includes('next poll'));
    assert.equal((await captureRefreshFixture('already-running')).exitCode, 0);
    assert.equal((await captureRefreshFixture('disabled')).exitCode, 1);
  });
  it('should keep diagnostics after primary output and preserve json purity', async () => {
    const result = await captureRefreshFixture('failed', { warnings: true });
    assert.deepEqual(
      result.events.map((e) => e.stream),
      ['stdout', 'stderr'],
    );
    assert.ok(result.events[1]!.text.indexOf('error') < result.events[1]!.text.indexOf('warning'));
    assert.match(result.events[1]!.text, /inspect native workflow status/u);
    const json = await captureRefreshFixture('queued', { json: true, color: true, warnings: true });
    assert.deepEqual(JSON.parse(json.events[0]!.text), json.result);
    assert.ok(!json.events.some((e) => e.text.includes('\u001b') || e.text.includes('messages')));
    assert.equal(json.calls.length, 1);
    assert.ok(json.calls[0]!.signal instanceof AbortSignal);
  });

  it('should group failure recovery without merging unrelated manifest capability conditions', async () => {
    const diagnostic = {
      [cliDiagnosticContext]: {
        condition: { key: 'review-capability', component: 'github-intake', fieldPath: '/review' },
        remediation: ['disable review requests'],
      },
      component: 'github-intake',
      code: 'github-notification-runtime-unsupported',
      fieldPath: '/review',
      severity: 'warning' as const,
      message: 'Review capability unavailable.',
    };
    const distinct = {
      ...diagnostic,
      fieldPath: '/feedback',
      [cliDiagnosticContext]: {
        condition: {
          key: 'feedback-capability',
          component: 'github-intake',
          fieldPath: '/feedback',
        },
      },
    };
    for (const json of [false, true])
      for (const name of ['unavailable', 'generic-failure'] as const) {
        const f = await captureRefreshFixture(name, {
          json,
          diagnostics: [diagnostic, diagnostic, distinct],
        });
        assert.equal(f.exitCode, 1);
        assert.equal(f.calls.length, 1);
        assert.ok(f.calls[0]!.signal instanceof AbortSignal && !f.calls[0]!.signal.aborted);
        assert.deepEqual(
          f.events.map(({ stream }) => stream),
          ['stdout', 'stderr'],
        );
        const stderr = f.events[1]!.text;
        assert.equal(stderr.match(/Review capability unavailable/gu)?.length, 2);
        assert.equal(stderr.match(/disable review requests/gu)?.length, 1);
        assert.equal(stderr.match(/notification refresh failed/gu)?.length, 1);
        if (!json) assert.equal(stderr.match(/✖ error/gu)?.length, 1);
        else assert.equal(f.events[0]!.text, `${JSON.stringify(f.result, undefined, 2)}\n`);
        if (name === 'unavailable') {
          assert.equal(stderr.match(/code=github-notification-runtime-unsupported/gu)?.length, 3);
          assert.match(stderr, /does not enable native openclaw notifications/u);
          assert.doesNotMatch(stderr, /resolve the cause/u);
        } else {
          assert.match(stderr, /diagnostic=ECONNREFUSED/u);
          assert.match(stderr, /resolve the cause/u);
        }
      }
  });
  it('should preserve literal data and color equivalence at narrow and wide widths', async () => {
    for (const name of refreshFixtureNames)
      for (const columns of [40, 120]) {
        const plain = await captureRefreshFixture(name, { columns });
        const color = await captureRefreshFixture(name, { columns, color: true });
        assert.deepEqual(
          color.events.map((e) => ({ ...e, text: ansis.strip(e.text) })),
          plain.events,
        );
        for (const e of plain.events)
          assert.ok(e.text.split('\n').every((line) => stringWidth(line) <= columns));
      }
  });
  it('should reject incomplete selectors before loading a manifest or requesting work', async () => {
    const result = await captureRefreshFixture('queued', { repository: refreshFixtureRepository });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.loads, []);
    assert.match(result.events[0]!.text, /github-notification-refresh-options-invalid/u);
  });
});
