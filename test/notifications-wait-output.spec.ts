import assert from 'node:assert/strict';
import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import { captureWaitPreview } from './notifications-wait-presentation-fixtures.ts';

describe('channels/github/cli/wait presentation', () => {
  it('should wrap selected widths without losing checkpoint data or changing color content', async () => {
    for (const name of [
      'baseline-success',
      'item-success',
      'timeout',
      'degraded',
      'invalid-options',
    ] as const) {
      const wide = await captureWaitPreview(name, { columns: 120 });
      for (const columns of [32, 80]) {
        const plain = await captureWaitPreview(name, { columns });
        const color = await captureWaitPreview(name, { columns, color: true });
        assert.deepEqual(
          color.events.map((e) => ({ ...e, text: ansis.strip(e.text) })),
          plain.events,
        );
        assert.ok(
          plain.events.every((e) =>
            e.text.split('\n').every((line) => stringWidth(line) <= columns),
          ),
        );
        assert.equal(
          plain.events
            .map((e) => e.text)
            .join('')
            .replace(/\s/gu, ''),
          wide.events
            .map((e) => e.text)
            .join('')
            .replace(/\s/gu, ''),
        );
        if (name !== 'invalid-options') {
          assert.ok(plain.events[0]!.text.startsWith('\n'));
          assert.ok(plain.events[0]!.text.endsWith('\n\n'));
        }
      }
    }
  });

  it('should retain scope, effective options, bounded observation, and exit semantics', async () => {
    const baseline = await captureWaitPreview('baseline-success');
    const baselineText = baseline.events.map(({ text }) => text).join('');
    assert.equal(baseline.exitCode, 0);
    assert.match(baselineText, /checkpoint +baseline-ready/u);
    assert.match(baselineText, /scope +baseline/u);
    assert.match(baselineText, /timeout +12s/u);
    assert.match(baselineText, /refresh +not requested/u);
    assert.match(baselineText, /status +checkpoint reached/u);
    assert.match(
      baselineText,
      /last observed +status=ready code=github-notification-status-ready baseline=ready/u,
    );

    const item = await captureWaitPreview('item-success');
    const itemText = item.events.map(({ text }) => text).join('');
    assert.equal(item.exitCode, 0);
    assert.match(itemText, /scope +tanaabased\/example#12 \(issue\)/u);
    assert.match(itemText, /refresh +requested/u);
    assert.match(
      itemText.replace(/\s+/gu, ' '),
      /item=approved stage=prepared worktree=ready reason=github-notification-item-prepared/u,
    );
    assert.ok(!itemText.includes('private'));

    assert.equal((await captureWaitPreview('timeout')).exitCode, 1);
    assert.equal((await captureWaitPreview('degraded')).exitCode, 1);
    assert.equal((await captureWaitPreview('invalid-options')).exitCode, 2);
  });

  it('should preserve the wait request and json result contract', async () => {
    const baseline = await captureWaitPreview('baseline-success', { json: true });
    assert.deepEqual(baseline.waitInput, {
      refresh: false,
      selector: undefined,
      target: 'baseline-ready',
      timeoutMs: 12_000,
    });
    const parsed = JSON.parse(baseline.events[0]!.text);
    assert.deepEqual(Object.keys(parsed).sort(), [
      'agentId',
      'code',
      'observation',
      'schemaVersion',
      'status',
      'target',
    ]);

    const item = await captureWaitPreview('item-success', { json: true });
    assert.deepEqual(item.waitInput, {
      refresh: true,
      selector: { itemType: 'issue', number: 12, repository: 'tanaabased/example' },
      target: 'prepared',
      timeoutMs: 12_000,
    });
  });
});
