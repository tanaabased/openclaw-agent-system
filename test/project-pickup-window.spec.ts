import assert from 'node:assert/strict';

import window from '../agent/project-pickup-window.ts';
import schedule from '../manifest/automation-schedule.ts';

describe('agent/project-pickup-window', () => {
  const evaluate = (now: string, cron = '30 23 * * *', windowMinutes = 120) =>
    window({
      schedule: schedule({ cron, timezone: 'America/New_York' }),
      anchor: Date.parse('2026-01-01T00:00:00Z'),
      timezone: 'UTC',
      windowMinutes,
      now: Date.parse(now),
    });
  it('should retain one opening across midnight with an exclusive close', () => {
    const before = evaluate('2026-10-29T03:30:00Z')!;
    assert.equal(before.opensAt, Date.parse('2026-10-29T03:30:00Z'));
    assert.deepEqual(evaluate('2026-10-29T04:15:00Z'), before);
    assert.equal(evaluate('2026-10-29T05:30:00Z'), undefined);
  });
  it('should skip a nonexistent spring opening without catch-up', () => {
    assert.equal(evaluate('2026-03-08T07:30:00Z', '30 2 * * *'), undefined);
    assert.equal(
      evaluate('2026-03-09T06:30:00Z', '30 2 * * *')!.opensAt,
      Date.parse('2026-03-09T06:30:00Z'),
    );
  });
  it('should use the first fall-fold instant only, including after restart', () => {
    const first = evaluate('2026-11-01T05:30:00Z', '30 1 * * *')!;
    assert.deepEqual(evaluate('2026-11-01T06:30:00Z', '30 1 * * *'), first);
    assert.equal(evaluate('2026-11-01T06:30:00Z', '30 1 * * *', 30), undefined);
  });
  it('should preserve an interval anchor and select the latest overlapping window', () => {
    const input = {
      schedule: schedule('every 1 hour'),
      anchor: 1000,
      timezone: 'UTC',
      windowMinutes: 90,
      now: 7201000,
    };
    assert.equal(window(input)!.opensAt, 7201000);
    assert.equal(window({ ...input, now: 7200999 })!.opensAt, 3601000);
    assert.equal(window({ ...input, now: 999 }), undefined);
  });
  it('should use the enrolled local timezone and preserve cron day semantics', () => {
    const input = {
      schedule: schedule('0 10 1 * 1'),
      anchor: Date.parse('2026-01-01'),
      timezone: 'Asia/Tokyo',
      windowMinutes: 60,
    };
    assert.equal(
      window({ ...input, now: Date.parse('2026-10-05T01:00:00Z') })!.opensAt,
      Date.parse('2026-10-05T01:00:00Z'),
    );
    assert.equal(window({ ...input, now: Date.parse('2026-10-06T01:00:00Z') }), undefined);
  });
});
