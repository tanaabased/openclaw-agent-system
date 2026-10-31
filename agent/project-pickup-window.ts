import { automationHash } from './automation-hash.ts';
import type { AutomationSchedule } from '../manifest/automation-schedule.ts';

const minute = 60000;
const day = 86400000;

/** evaluate eligibility only; native schedulers still own invocation and activation. */
export default function projectPickupWindow(input: {
  schedule: AutomationSchedule;
  windowMinutes: number;
  anchor: number;
  timezone: string;
  now: number;
}) {
  const { schedule, anchor, now } = input;
  const duration = input.windowMinutes * minute;
  if (![anchor, now, duration].every(Number.isSafeInteger) || duration <= 0 || now < anchor) return;
  let opensAt: number | undefined;
  if (schedule.kind === 'every') {
    const interval = schedule.seconds * 1000;
    opensAt = anchor + Math.floor((now - anchor) / interval) * interval;
  } else if (schedule.kind === 'cron') {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: schedule.timezone ?? input.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    const wall = (time: number) => {
      const parts = Object.fromEntries(format.formatToParts(time).map((p) => [p.type, p.value]));
      return Date.UTC(
        +parts.year!,
        +parts.month! - 1,
        +parts.day!,
        +parts.hour!,
        +parts.minute!,
        +parts.second!,
      );
    };
    const today = Math.floor(wall(now) / day) * day;
    const earliest = Math.max(anchor, now - duration + 1);
    const f = schedule.fields;
    // a valid five-field cron repeats within eight years, including leap-day weekday restrictions.
    for (
      let date = today;
      date >= today - 8 * 366 * day && date >= earliest - 2 * day;
      date -= day
    ) {
      const calendar = new Date(date);
      const monthDay = f.days.includes(calendar.getUTCDate());
      const weekDay = f.weekdays.includes(calendar.getUTCDay());
      if (
        !f.months.includes(calendar.getUTCMonth() + 1) ||
        !(f.dayWildcard || f.weekdayWildcard ? monthDay && weekDay : monthDay || weekDay)
      )
        continue;
      // sampling both sides of the date discovers offsets on either side of a clock change.
      const offsets = new Set(
        [-2, -1, 0, 1, 2].map((n) => wall(date + n * day) - (date + n * day)),
      );
      for (const hour of f.hours)
        for (const mins of f.minutes) {
          const target = date + hour * 3600000 + mins * minute;
          const matches = [...offsets]
            .map((offset) => target - offset)
            .filter((time) => wall(time) === target);
          // gaps have no instant; folds always use the first instant, even after restart.
          const time = Math.min(...matches);
          if (time >= earliest && time <= now && (opensAt === undefined || time > opensAt))
            opensAt = time;
        }
      if (opensAt !== undefined && date < today - day) break;
    }
  }
  if (opensAt === undefined || now >= opensAt + duration) return;
  return {
    id: automationHash({ anchor, opensAt, schedule, timezone: input.timezone }),
    opensAt,
    closesAt: opensAt + duration,
  };
}
