import { Temporal } from '@js-temporal/polyfill';
import { Cron } from 'croner';

import { CodexAutomationError } from './codex-automation-state.ts';
import type { AutomationSchedule } from '../manifest/automation-schedule.ts';

const dayMs = 86_400_000;
const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
type CalendarGroup = { year: number; count: number };

function unsupported(): never {
  throw new CodexAutomationError('automation-timezone-recurrence-unsupported');
}

function calendarKeys(date: Date): string[] {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const last = new Date(Date.UTC(date.getUTCFullYear(), month, 0)).getUTCDate();
  return [day, day - last - 1].map((value) => `${month}/${value}/${date.getUTCDay()}`);
}

/** group equivalent years over a full gregorian cycle using actual timezone transitions. */
function calendars(timezone: string, year: number) {
  const groups = new Map<string, CalendarGroup>();
  const counts = new Map<string, number>();
  let transition = Temporal.Instant.fromEpochMilliseconds(Date.UTC(year, 0, 1))
    .toZonedDateTimeISO(timezone)
    .getTimeZoneTransition('next');
  for (let current = year; current < year + 400; current++) {
    const start = Date.UTC(current, 0, 1);
    const end = Date.UTC(current + 1, 0, 1);
    const offset =
      Temporal.Instant.fromEpochMilliseconds(start).toZonedDateTimeISO(timezone).offsetNanoseconds;
    const changes: number[][] = [];
    while (transition && transition.epochMilliseconds < end) {
      const date = new Date(transition.epochMilliseconds);
      changes.push([
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
        transition.offsetNanoseconds,
      ]);
      transition = transition.getTimeZoneTransition('next');
    }
    const signature = JSON.stringify([
      new Date(start).getUTCDay(),
      (end - start) / dayMs,
      offset,
      changes,
    ]);
    const group = groups.get(signature) ?? { year: current, count: 0 };
    group.count++;
    groups.set(signature, group);
    // irregular calendars must not turn planning into unbounded occurrence expansion.
    if (groups.size > 32) return unsupported();
    for (let instant = start; instant < end; instant += dayMs)
      for (const key of calendarKeys(new Date(instant)))
        counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { groups, counts };
}

/** compile recurring utc calendar predicates, without timers, expiry dates, or periodic renewal. */
export default function codexAutomationUtc(
  schedule: Extract<AutomationSchedule, { kind: 'cron' }>,
  year = new Date().getUTCFullYear(),
): string {
  const { fields: f, timezone } = schedule;
  if (!timezone || f.hours.length !== 1 || !Number.isInteger(year) || year < 1970 || year > 9000)
    return unsupported();
  const { groups, counts } = calendars(timezone, year);
  const expression = [
    f.minutes.join(','),
    f.hours.join(','),
    f.days.join(','),
    f.months.join(','),
    f.weekdays.join(','),
  ].join(' ');
  const occurrences = new Map<string, number>();
  const candidates: string[][] = [];
  for (const group of groups.values()) {
    // no callback means croner evaluates dates only; it never starts a scheduler.
    const cron = new Cron(expression, { timezone, domAndDow: true });
    try {
      let date = cron.nextRun(new Date(Date.UTC(group.year, 0, 1) - 1));
      const end = Date.UTC(group.year + 1, 0, 1);
      let runs = 0;
      while (date && date.getTime() < end) {
        if (++runs > 732 || date.getUTCSeconds() !== 0) return unsupported();
        const keys = calendarKeys(date).map(
          (key) => `${key}/${date!.getUTCHours()}/${date!.getUTCMinutes()}`,
        );
        candidates.push(keys);
        for (const key of keys) occurrences.set(key, (occurrences.get(key) ?? 0) + group.count);
        date = cron.nextRun(date);
      }
    } finally {
      cron.stop();
    }
  }
  const selected = new Map<string, Set<number>>();
  for (const keys of candidates) {
    // positive dates handle ordinary days; negative dates retain month-end/leap semantics.
    const key = keys.find((candidate) => {
      const parts = candidate.split('/');
      return occurrences.get(candidate) === counts.get(parts.slice(0, 3).join('/'));
    });
    if (!key) return unsupported();
    const [month, day, weekday, hour, minute] = key.split('/');
    const predicate = `${month}/${weekday}/${hour}/${minute}`;
    const days = selected.get(predicate) ?? new Set<number>();
    days.add(Number(day));
    selected.set(predicate, days);
  }
  const combined = new Map<string, number[]>();
  for (const [key, days] of selected) {
    const [month, weekday, hour, minute] = key.split('/');
    const predicate = `${month}/${hour}/${minute}/${[...days].sort((a, b) => a - b).join(',')}`;
    const values = combined.get(predicate) ?? [];
    values.push(Number(weekday));
    combined.set(predicate, values);
  }
  const rules = [...combined]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, days]) => {
      const [month, hour, minute, dates] = key.split('/');
      return `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${days
        .sort((a, b) => a - b)
        .map((day) => weekdays[day])
        .join(',')};BYMONTHDAY=${dates};BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`;
    });
  if (!rules.length) return unsupported();
  return `DTSTART:19700101T000000Z\n${rules.join('\n')}`;
}
