import assert from 'node:assert/strict';

import normalize from '../manifest/automation-schedule.ts';

describe('manifest/automation-schedule', () => {
  it('should normalize recurring durations and keep relative delays unanchored', () => {
    for (const input of [
      ' every  1 hour ',
      { every: '60 minutes' },
      { every: '3600 seconds', 'missed-run': 'native' },
    ]) {
      assert.deepEqual(normalize(input), { kind: 'every', seconds: 3600, missedRun: 'native' });
    }
    assert.deepEqual(normalize('in 1 day'), { kind: 'in', seconds: 86400, missedRun: 'native' });
    assert.deepEqual(normalize({ in: '24 hours' }), normalize('in 1 day'));
  });

  it('should strictly validate timestamps and normalize offsets to utc', () => {
    assert.deepEqual(normalize('2028-02-29T10:01:02.12-05:00'), {
      kind: 'at',
      at: '2028-02-29T15:01:02.120Z',
      missedRun: 'native',
    });
    assert.deepEqual(
      normalize({ at: '2028-02-29T15:01:02.120Z' }),
      normalize('2028-02-29T10:01:02.12-05:00'),
    );
    for (const value of [
      '2027-02-29T00:00:00Z',
      '2028-04-31T00:00:00Z',
      '2028-01-01T24:00:00Z',
      '2028-01-01T00:00:60Z',
      '2028-01-01T00:00:00.1234Z',
      '2028-01-01T00:00:00',
      '2028-01-01T00:00Z',
      '2028-01-01T00:00:00+24:00',
      '2028-01-01T00:00:00+00:60',
    ])
      assert.throws(() => normalize(value), value);
  });

  it('should canonicalize numeric cron without losing day wildcard semantics', () => {
    const schedule = normalize({ cron: '0,30 9-17/2 * 1-12 1-5', timezone: 'America/New_York' });
    assert.equal(schedule.kind, 'cron');
    if (schedule.kind !== 'cron') return;
    assert.deepEqual(schedule.fields.minutes, [0, 30]);
    assert.deepEqual(schedule.fields.hours, [9, 11, 13, 15, 17]);
    assert.equal(schedule.fields.dayWildcard, true);
    assert.equal(schedule.fields.weekdayWildcard, false);
    assert.deepEqual(
      schedule,
      normalize({
        cron: '30,0,0 9,11,13,15,17 * * 1,2,3,4,5',
        timezone: 'America/New_York',
        'missed-run': 'native',
      }),
    );
    assert.notDeepEqual(normalize('0 9 * * 1'), normalize('0 9 1-31 * 1'));
    assert.equal(normalize('0 9 * * *').missedRun, 'native');
  });

  it('should reject impossible calendars but retain leap days and restricted-day or semantics', () => {
    assert.throws(() => normalize('0 0 31 2 *'));
    assert.throws(() => normalize('0 0 31 4,6,9,11 *'));
    assert.equal(normalize('0 0 29 2 *').kind, 'cron');
    assert.equal(normalize('0 0 29 2 */2').kind, 'cron');
    assert.equal(normalize('0 0 31 4,5 *').kind, 'cron');
    assert.equal(normalize('0 0 */2 2 1').kind, 'cron');
    assert.equal(normalize('0 0 31 2 1').kind, 'cron');
    assert.throws(() => normalize('0 0 31 2 */2'));
  });

  it('should reject guesses, unsupported grammar, overflow and ambiguous objects', () => {
    for (const value of [
      '',
      'hourly',
      'every 0 seconds',
      'every 1 hours',
      'every 2 hour',
      'every 1.5 hours',
      'every 1 hour 5 minutes',
      'in -1 day',
      'every 9007199254740992 days',
      '0 0 * * * *',
      '@daily',
      '0 0 * * MON',
      '60 0 * * *',
      '0 24 * * *',
      '0 0 0 * *',
      '0 0 * 13 *',
      '0 0 * * 7',
      '0 0 * * 5-1',
      '*/0 * * * *',
      '1/2 * * * *',
      '0 0 L * *',
      { every: '1 hour', in: '1 hour' },
      { every: '1 hour', timezone: 'native' },
      { every: '1 hour', 'missed-run': 'skip' },
      { every: 3600 },
      { cron: '* * * * *', timezone: 'Mars/Olympus' },
      { cron: '* * * * *', timezone: '+01:00' },
      { cron: '* * * * *', timezone: null },
      { cron: '* * * * *', extra: true },
    ])
      assert.throws(() => normalize(value), JSON.stringify(value));
  });
});
