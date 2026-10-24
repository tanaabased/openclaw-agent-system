import assert from 'node:assert/strict';

import { Cron } from 'croner';
import { rrulestr } from 'rrule';

import compile from '../agent/codex-automation-schedule.ts';
import normalize from '../manifest/automation-schedule.ts';

const rule = (cron: string, timezone: string, year = 2026) =>
  compile(normalize({ cron, timezone }), year);
const next = (source: string, after: string) =>
  rrulestr(source, { forceset: true }).after(new Date(after))?.toISOString();

describe('agent/codex-automation-utc', () => {
  it('should retain new york wall time across dst and host zones without an expiry', () => {
    const compiled = rule('0 8 * * *', 'America/New_York');
    const original = process.env.TZ;
    try {
      for (const zone of ['UTC', 'America/New_York', 'America/Los_Angeles']) {
        process.env.TZ = zone;
        for (const [date, hour] of [
          ['2026-03-07', '13'],
          ['2026-03-08', '12'],
          ['2026-10-31', '12'],
          ['2026-11-01', '13'],
          ['2500-06-01', '12'],
        ])
          assert.equal(next(compiled, `${date}T00:00:00Z`), `${date}T${hour}:00:00.000Z`);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    assert.equal(rule('0 8 * * *', 'America/New_York', 2027), compiled);
  });

  it('should preserve weekdays, fractional offsets and month ends across leap years', () => {
    const london = rule('0 8 * * 1-5', 'Europe/London');
    assert.equal(next(london, '2026-03-27T12:00:00Z'), '2026-03-30T07:00:00.000Z');
    const kathmandu = rule('30 0 1 * *', 'Asia/Kathmandu');
    assert.equal(next(kathmandu, '2027-02-28T00:00:00Z'), '2027-02-28T18:45:00.000Z');
    assert.equal(next(kathmandu, '2028-02-28T00:00:00Z'), '2028-02-29T18:45:00.000Z');
    const lordHowe = rule('0 8 * * *', 'Australia/Lord_Howe');
    assert.equal(next(lordHowe, '2026-04-03T22:00:00Z'), '2026-04-04T21:30:00.000Z');
  });

  it('should preserve the openclaw evaluator behavior at skipped and repeated local times', () => {
    for (const expression of ['30 1 * * *', '30 2 * * *']) {
      const compiled = rule(expression, 'America/New_York');
      const cron = new Cron(expression, { timezone: 'America/New_York' });
      try {
        for (const start of ['2026-03-06T00:00:00Z', '2026-10-30T00:00:00Z']) {
          const expected = cron.nextRuns(5, new Date(start));
          let previous = start;
          for (const date of expected) {
            assert.equal(next(compiled, previous), date.toISOString());
            previous = date.toISOString();
          }
        }
      } finally {
        cron.stop();
      }
    }
  });

  it('should compile utc directly and reject calendars that cannot repeat faithfully', () => {
    assert.equal(
      next(rule('15 * * * *', 'UTC'), '2026-03-08T01:16:00Z'),
      '2026-03-08T02:15:00.000Z',
    );
    for (const [cron, timezone] of [
      ['0 8 * * *', 'Africa/Casablanca'],
      ['0 * * * *', 'America/New_York'],
    ])
      assert.throws(() => rule(cron!, timezone!), {
        code: 'automation-timezone-recurrence-unsupported',
      });
  });

  it('should preserve stepped month-day selections through utc conversion', () => {
    const compiled = rule('0 8 */2 * *', 'America/New_York');
    assert.equal(next(compiled, '2026-01-01T14:00:00Z'), '2026-01-03T13:00:00.000Z');
  });
});
