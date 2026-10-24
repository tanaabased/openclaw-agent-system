import assert from 'node:assert/strict';

import compile from '../agent/codex-automation-schedule.ts';
import normalize from '../manifest/automation-schedule.ts';

const now = new Date('2026-10-24T12:00:00Z');
const rule = (input: unknown) => compile(normalize(input), undefined, now);

describe('agent/codex-automation-schedule', () => {
  it('should map named zones directly without changing requested clock fields', () => {
    for (const [cron, expected] of [
      ['15 * * * *', 'FREQ=HOURLY;BYMINUTE=15'],
      ['30 8 * * *', 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30'],
      ['0 9 * * 1-5', 'FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR'],
      ['0 8 1,15 * *', 'FREQ=MONTHLY;BYHOUR=8;BYMINUTE=0;BYMONTHDAY=1,15'],
    ])
      assert.equal(
        rule({ cron, timezone: 'Australia/Darwin' }),
        `DTSTART;TZID=Australia/Darwin:20261023T000000\nRRULE:${expected};BYSECOND=0`,
      );
  });

  it('should leave valid timezone calendars to the native scheduler for daily and hourly rules', () => {
    for (const timezone of [
      'Africa/Casablanca',
      'Africa/El_Aaiun',
      'America/Edmonton',
      'America/Vancouver',
      'Asia/Gaza',
      'Asia/Hebron',
      'America/New_York',
    ]) {
      assert.equal(
        rule({ cron: '0 8 * * *', timezone }),
        `DTSTART;TZID=${timezone}:20261023T000000\nRRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0`,
      );
      assert.equal(
        rule({ cron: '15 * * * *', timezone }),
        `DTSTART;TZID=${timezone}:20261023T000000\nRRULE:FREQ=HOURLY;BYMINUTE=15;BYSECOND=0`,
      );
    }
  });

  it('should preserve native local and utc forms independently of the compiling host timezone', () => {
    const original = process.env.TZ;
    try {
      for (const zone of ['UTC', 'America/New_York', 'America/Los_Angeles']) {
        process.env.TZ = zone;
        for (const input of ['0 8 * * *', { cron: '0 8 * * *', timezone: null }])
          assert.equal(rule(input), 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0');
        assert.equal(
          rule({ cron: '15 * * * *', timezone: 'UTC' }),
          'DTSTART:20261023T000000Z\nRRULE:FREQ=HOURLY;BYMINUTE=15;BYSECOND=0',
        );
        assert.equal(
          rule({ cron: '0 8 * * *', timezone: 'America/New_York' }),
          'DTSTART;TZID=America/New_York:20261023T000000\nRRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0',
        );
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('should retain the owned start across syncs and timezone or clock edits', () => {
    const input = { cron: '15 * * * *', timezone: 'America/New_York' };
    const previous = rule(input);
    const later = new Date('2027-01-01T00:00:00Z');
    assert.equal(compile(normalize(input), previous, later), previous);
    assert.equal(
      compile(normalize({ ...input, timezone: 'UTC' }), previous, later),
      'DTSTART:20261023T000000Z\nRRULE:FREQ=HOURLY;BYMINUTE=15;BYSECOND=0',
    );
    assert.equal(
      compile(normalize({ ...input, cron: '30 * * * *' }), previous, later),
      previous.replace('BYMINUTE=15', 'BYMINUTE=30'),
    );
  });
});
