import { CodexAutomationError } from './codex-automation-state.ts';
import type { AutomationSchedule } from '../manifest/automation-schedule.ts';

/** compile only one-job recurrences with demonstrated native equivalents. */
export default function codexAutomationSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === 'every') {
    const unit = schedule.seconds % 3600 === 0 ? 3600 : 60;
    const interval = schedule.seconds / unit;
    if (!Number.isInteger(interval) || interval < 1 || interval > (unit === 60 ? 1440 : 999)) {
      throw new CodexAutomationError('automation-schedule-unsupported');
    }
    return `FREQ=${unit === 3600 ? 'HOURLY' : 'MINUTELY'};INTERVAL=${interval}`;
  }
  if (schedule.kind !== 'cron') throw new CodexAutomationError('automation-one-shot-unsupported');
  if (schedule.timezone !== 'native')
    throw new CodexAutomationError('automation-timezone-unsupported');
  const f = schedule.fields;
  if (f.months.length !== 12 || f.minutes.length !== 1 || (!f.dayWildcard && !f.weekdayWildcard)) {
    throw new CodexAutomationError('automation-schedule-unsupported');
  }
  const dailyDays = f.days.length === 31 && f.weekdays.length === 7;
  if (f.hours.length === 24 && dailyDays) return `FREQ=HOURLY;BYMINUTE=${f.minutes[0]}`;
  if (f.hours.length !== 1) throw new CodexAutomationError('automation-schedule-unsupported');
  const time = `BYHOUR=${f.hours[0]};BYMINUTE=${f.minutes[0]}`;
  if (dailyDays) return `FREQ=DAILY;${time}`;
  if (f.days.length === 31) {
    const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    return `FREQ=WEEKLY;${time};BYDAY=${f.weekdays.map((day) => days[day]).join(',')}`;
  }
  if (f.weekdays.length === 7) return `FREQ=MONTHLY;${time};BYMONTHDAY=${f.days.join(',')}`;
  throw new CodexAutomationError('automation-schedule-unsupported');
}
