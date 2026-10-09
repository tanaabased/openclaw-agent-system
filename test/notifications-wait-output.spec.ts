import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { captureWaitPreview } from './notifications-wait-presentation-fixtures.ts';

describe('channels/github/cli/wait presentation', () => {
  it('should match illustrative checkpoint command previews', async () => {
    const previews = ['illustrative fixture data; no provider operations\n'];
    for (const name of [
      'baseline-success',
      'item-success',
      'timeout',
      'degraded',
      'invalid-options',
    ] as const) {
      const { events } = await captureWaitPreview(name);
      previews.push(
        `## ${name}\n${events.map(({ stream, text }) => `[${stream}]\n${text}`).join('')}`,
      );
    }
    assert.equal(
      previews.join('\n'),
      await readFile(new URL('./notifications-wait-previews.txt', import.meta.url), 'utf8'),
    );
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
      agentId: 'fixture-agent',
      executionSurface: 'cli-one-shot',
      refresh: false,
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
      agentId: 'fixture-agent',
      executionSurface: 'cli-one-shot',
      refresh: true,
      selector: { itemType: 'issue', number: 12, repository: 'tanaabased/example' },
      target: 'prepared',
      timeoutMs: 12_000,
    });
  });
});
