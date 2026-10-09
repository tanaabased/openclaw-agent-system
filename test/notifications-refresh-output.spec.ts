import assert from 'node:assert/strict';

import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import {
  captureRefreshFixture,
  refreshFixtureAgent,
  refreshFixtureNames,
  refreshFixtureRepository,
} from './notifications-refresh-presentation-fixtures.ts';

const compact = (text: string) => ansis.strip(text).replace(/\s/gu, '');

describe('channels/github/cli/refresh presentation', () => {
  it('should show resolved scope, effective timeout, baseline, and counts', async () => {
    const baseline = await captureRefreshFixture('baseline-establishment');
    const text = baseline.events[0]!.text;
    assert.match(text, /agent {2,}Agent-MixedCase/u);
    assert.match(text, /scope {2,}all items/u);
    assert.match(text, /timeout {2,}300s \(default\)/u);
    assert.match(
      text,
      /baseline {2,}established at 2026-09-01T00:00:00.000Z with 3 existing assignments/u,
    );
    assert.match(text, /items {2,}baseline=3 approved=0 rejected=0 duplicate=0 retired=0/u);
    const empty = await captureRefreshFixture('no-new-work');
    assert.match(empty.events[0]!.text, /status {2,}completed/u);
    assert.match(empty.events[0]!.text, /baseline {2,}ready since 2026-09-01T00:00:00.000Z/u);
    assert.equal(empty.events.length, 1);
    const filtered = await captureRefreshFixture('filtered');
    assert.ok(filtered.events[0]!.text.includes(`pull-request ${refreshFixtureRepository}#12`));
    assert.match(filtered.events[0]!.text, /timeout {2,}12s\n/u);
  });

  it('should distinguish disabled, throttled, failed, and partial outcomes without changing exits', async () => {
    for (const [name, outcome, exitCode] of [
      ['disabled', 'disabled', 1],
      ['throttled', 'throttled', 1],
      ['failed', 'failed', 1],
      ['partial-failure', 'completed with item failures', 0],
    ] as const) {
      const fixture = await captureRefreshFixture(name);
      assert.equal(fixture.exitCode, exitCode);
      assert.ok(fixture.events[0]!.text.includes(outcome));
      assert.ok(fixture.events[0]!.text.includes(fixture.result.code));
      assert.deepEqual(
        fixture.events.map(({ stream }) => stream),
        ['stdout', 'stderr'],
      );
    }
    const throttled = await captureRefreshFixture('throttled');
    assert.match(throttled.events[0]!.text, /retry {2,}2026-09-01T00:02:00.000Z/u);
    assert.match(throttled.events[0]!.text, /next poll {2,}2026-09-01T00:01:00.000Z/u);
    assert.ok(throttled.events[1]!.text.includes('provider rate limit'));
    const failed = await captureRefreshFixture('failed');
    assert.ok(failed.events[0]!.text.includes('ExternalDiagnostic-MixedCase'));
    const partial = await captureRefreshFixture('partial-failure');
    const failures = compact(partial.events[0]!.text);
    for (const identity of [`${refreshFixtureRepository}#12`, 'OtherOwner/Second-Repository#34'])
      assert.ok(failures.includes(identity));
    assert.ok(failures.includes('issuestage=permission-checkcause=repository-permission-denied'));
    assert.ok(
      failures.includes('pull-requeststage=permission-checkcause=repository-permission-denied'),
    );
    assert.ok(!partial.events[0]!.text.includes('check repository write access'));
    assert.ok(partial.events[1]!.text.includes('check repository write access'));
  });

  it('should put recovery after primary output in one severity-sorted section', async () => {
    const fixture = await captureRefreshFixture('partial-failure', { warnings: true, color: true });
    assert.deepEqual(
      fixture.events.map(({ stream }) => stream),
      ['stdout', 'stderr'],
    );
    const messages = ansis.strip(fixture.events[1]!.text);
    assert.equal(messages.match(/\nmessages\n/gu)?.length, 1);
    assert.ok(messages.indexOf('error') < messages.indexOf('warning'));
    assert.equal(messages.match(/check repository write access and retry refresh/gu)?.length, 1);
    assert.ok(messages.includes('External Warning: MixedCase.yaml is shadowed.'));
    assert.ok(fixture.events[0]!.text.includes('\u001b[33mcompleted with item failures'));
    assert.ok(fixture.events[0]!.text.includes('\u001b[31mfailure'));
    assert.ok(
      fixture.events[1]!.text.includes('  check repository write access and retry refresh\n'),
    );
    const disabled = await captureRefreshFixture('disabled', { warnings: true });
    const disabledMessages = disabled.events[1]!.text;
    assert.ok(disabledMessages.indexOf('warning') < disabledMessages.indexOf('info'));
  });

  it('should preserve literal data and color equivalence at wide and narrow widths', async () => {
    for (const name of refreshFixtureNames) {
      for (const columns of [40, 120]) {
        const plain = await captureRefreshFixture(name, { columns });
        const color = await captureRefreshFixture(name, { columns, color: true });
        assert.deepEqual(
          color.events.map(({ stream, text }) => ({ stream, text: ansis.strip(text) })),
          plain.events,
        );
        for (const { text } of plain.events) {
          assert.ok(text.split('\n').every((line) => stringWidth(line) <= columns));
        }
        const text = compact(plain.events[0]!.text);
        assert.ok(text.includes(refreshFixtureAgent));
        assert.ok(text.includes(plain.result.code));
        if (name === 'filtered' || name === 'partial-failure')
          assert.ok(text.includes(`${refreshFixtureRepository}#12`));
        if (plain.result.retryAt !== undefined)
          assert.ok(text.includes(new Date(plain.result.retryAt).toISOString()));
        assert.ok(plain.events[0]!.text.startsWith('\n') && plain.events[0]!.text.endsWith('\n\n'));
      }
    }
  });

  it('should preserve one-shot selector forwarding, lease bounds, json, and machine diagnostics', async () => {
    for (const name of refreshFixtureNames) {
      const fixture = await captureRefreshFixture(name, {
        json: true,
        color: true,
        warnings: true,
      });
      assert.deepEqual(fixture.loads, [refreshFixtureAgent]);
      assert.equal(fixture.calls.length, 1);
      const call = fixture.calls[0]!;
      assert.equal(call.agentId, refreshFixtureAgent);
      assert.equal(call.bypassInterval, true);
      assert.equal(call.executionSurface, 'cli-one-shot');
      assert.ok(call.signal instanceof AbortSignal);
      assert.equal(call.signal.aborted, false);
      assert.equal(call.waitForLeaseMs, name === 'filtered' ? 12_000 : 120_000);
      assert.deepEqual(
        call.selector,
        name === 'filtered'
          ? { itemType: 'pull-request', repository: refreshFixtureRepository, number: 12 }
          : undefined,
      );
      assert.deepEqual(JSON.parse(fixture.events[0]!.text), fixture.result);
      assert.equal(
        fixture.events[1]!.text,
        'manifest: External Warning: MixedCase.yaml is shadowed. code=manifest-shadowed\n',
      );
      assert.equal(fixture.exitCode, fixture.result.status === 'completed' ? 0 : 1);
      assert.ok(
        fixture.events.every(({ text }) => !text.includes('\u001b') && !text.includes('messages')),
      );
    }
  });

  it('should reject incomplete and invalid selectors before manifest loading or intake', async () => {
    for (const json of [false, true]) {
      for (const options of [
        { repository: refreshFixtureRepository },
        { repository: refreshFixtureRepository, itemKind: 'invalid', itemNumber: '12' },
        { repository: refreshFixtureRepository, itemKind: 'issue', itemNumber: '0' },
      ]) {
        const fixture = await captureRefreshFixture('no-new-work', { ...options, json });
        assert.deepEqual(fixture.loads, []);
        assert.deepEqual(fixture.calls, []);
        assert.equal(fixture.exitCode, 2);
        assert.deepEqual(
          fixture.events.map(({ stream }) => stream),
          ['stderr'],
        );
        assert.ok(fixture.events[0]!.text.includes('github-notification-refresh-options-invalid'));
        if (json) assert.ok(!fixture.events[0]!.text.includes('messages'));
      }
    }
  });
});
