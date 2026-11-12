import window from '../agent/issue-pickup-window.ts';
import parseManifest from '../manifest/parse.ts';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import timing from '../channels/github/issue-pickup-timing.ts';
import decode, { issuePickupConfigurationCode } from '../channels/github/issue-pickup-schema.ts';
import scheduleCondition from '../agent/automations/automation-schedule-condition.ts';
import codexSchedule from '../agent/automations/codex-automation-schedule.ts';
import { pickupFixture } from './issue-pickup-fixture.ts';
import duration from '../manifest/duration.ts';
import timeOfDay from '../manifest/time-of-day.ts';

const projects = [{ repository: 'owner/repo', milestone: { number: 10, policy: 'only' as const } }];
describe('issue pickup timing', () => {
  it('should accept the new manifest inputs and reject retired pilot fields', () => {
    const parse = (pickup: Record<string, unknown>) =>
      parseManifest(
        JSON.stringify({
          'schema-version': 1,
          agent: { id: 'receiver' },
          github: {
            username: 'receiver',
            routing: ['owner/*'],
            'issue-assignment': {},
            'issue-pickup': { projects, ...pickup },
          },
        }),
      );
    assert.equal(parse({}).status, 'valid');
    assert.equal(
      parse({ start: '3 A.M.', window: '2h', duration: '120 minutes', end: '05:00' }).status,
      'valid',
    );
    assert.equal(parse({ window: '2h', duration: '3h' }).status, 'invalid');
    for (const retired of [{ schedule: '0 3 * * *' }, { 'window-minutes': 120 }])
      assert.equal(parse(retired).status, 'invalid');
  });
  it('should allow installation within the current window but never before activation or after closing', () => {
    const pickup = timing({});
    const anchor = Date.parse('2026-11-03T04:00:00Z');
    const evaluate = (now: number) => window({ ...pickup, anchor, now, timezone: 'UTC' });
    assert.equal(evaluate(anchor - 1), undefined);
    assert.equal(evaluate(anchor)?.opensAt, Date.parse('2026-11-03T03:00:00Z'));
    assert.equal(evaluate(Date.parse('2026-11-03T05:00:00Z')), undefined);
  });

  it('should normalize the proposed clock and duration forms to one daily schedule', () => {
    const canonical = timing({});
    for (const input of [
      { start: '03:00', window: '2 hours', scans: 8 },
      { start: '3 am', window: '120 minutes' },
      { start: '3 A.M.', window: '2 hrs' },
      { start: '3:00am', window: '2h' },
      { start: '0300', window: '2h' },
      { start: '3', window: '7200 seconds', duration: '120 min', end: '5 AM' },
    ])
      assert.deepEqual(timing(input), canonical);
    assert.equal(canonical.windowMinutes, 120);
    assert.equal(canonical.scanSchedule!.kind, 'cron');
    if (canonical.scanSchedule!.kind === 'cron')
      assert.deepEqual(canonical.scanSchedule!.times, [180, 195, 210, 225, 240, 255, 270, 285]);
    assert.deepEqual(
      timing({ start: '14:30', duration: '1 hour 30 minutes', scans: 6 }),
      timing({ start: '2:30 PM', window: '5400 seconds', scans: 6 }),
    );
    assert.equal(timing({ start: '11 pm', end: '1 am' }).windowMinutes, 120);
    assert.equal(timeOfDay('12 AM'), 0);
    assert.equal(timeOfDay('12 p.m.'), 720);
    assert.equal(timing({ window: '90 seconds', scans: 1 }).windowMinutes, 1.5);
  });

  it('should reject conflicting fields and unsupported clock precision without guessing', () => {
    assert.throws(() => timing({ window: '2h', duration: '3h' }), /timing-conflict/);
    assert.throws(() => timing({ window: '2h', end: '06:00' }), /timing-conflict/);
    assert.throws(() => timing({ window: '90 seconds' }), /schedule-precision/);
    assert.throws(() => timing({ window: '3 minutes', scans: 8 }), /schedule-precision/);
    for (const value of ['24:00', '13 pm', '3:60', '03:00:30', 'tomorrow', '-3am', '1.5'])
      assert.throws(() => timeOfDay(value));
    for (const value of ['2', '-2h', '2h garbage', 'Infinity hours', '0s'])
      assert.throws(() => duration(value));
    const f = pickupFixture();
    f.policy.issuePickup = decode({ window: '2h', duration: '3h', projects });
    assert.equal(issuePickupConfigurationCode(f.policy), 'issue-pickup-timing-conflict');
  });

  it('should project exact slots to codex and suppress extra cron matches before openclaw model execution', () => {
    const defaults = timing({}).scanSchedule;
    assert.equal(scheduleCondition(defaults, 'UTC'), undefined);
    const everyMinute = timing({ window: '24h', scans: 1440 }).scanSchedule;
    assert.ok(!codexSchedule(everyMinute).includes('BYSETPOS'));
    assert.throws(
      () => codexSchedule(timing({ window: '24h', scans: 1439 }).scanSchedule),
      /automation-schedule-unsupported/,
    );
    assert.equal(scheduleCondition(defaults, 'UTC', 'json({fire:true});'), 'json({fire:true});');
    const schedule = timing({ start: '14:30', window: '90m', scans: 6 }).scanSchedule!;
    assert.equal(
      codexSchedule(schedule),
      'FREQ=DAILY;BYHOUR=14,15;BYMINUTE=0,15,30,45;BYSETPOS=3,4,5,6,7,8',
    );
    const script = scheduleCondition(schedule, 'America/New_York')!;
    for (const [local, fire] of [
      ['14:00', false],
      ['14:15', false],
      ['14:30', true],
      ['15:45', true],
      ['16:00', false],
    ] as const) {
      const now = new Date(`2026-11-03T${local}:00-05:00`);
      let result: unknown;
      runInNewContext(script, {
        Date: class extends Date {
          constructor() {
            super(now.getTime());
          }
        },
        Intl,
        json: (value: unknown) => {
          result = value;
        },
      });
      assert.equal((result as { fire: boolean }).fire, fire);
    }
  });

  it('should space non-divisible scan counts at native minute precision and keep midnight slots', () => {
    const seven = timing({ scans: 7 }).scanSchedule!;
    assert.ok(seven.kind === 'cron');
    assert.deepEqual(seven.times, [180, 197, 214, 231, 248, 265, 282]);
    const overnight = timing({ start: '11 pm', end: '1 am' }).scanSchedule!;
    assert.ok(overnight.kind === 'cron');
    assert.deepEqual(overnight.times, [0, 15, 30, 45, 1380, 1395, 1410, 1425]);
  });
});
