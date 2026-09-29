export interface AutomationCronFields {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  dayWildcard: boolean;
  weekdayWildcard: boolean;
}
export type AutomationSchedule = (
  | { kind: 'every' | 'in'; seconds: number }
  | { kind: 'at'; at: string }
  | { kind: 'cron'; fields: AutomationCronFields; timezone: string }
) & { missedRun: 'native' };

function invalid(): never {
  throw new Error('Invalid automation schedule.');
}

function duration(source: string): number {
  const match = /^(\d+) (second|minute|hour|day)(s?)$/u.exec(source);
  if (!match) return invalid();
  const amount = Number(match[1]);
  if (amount < 1 || (amount === 1 ? match[3] !== '' : match[3] !== 's')) return invalid();
  const multiplier = { second: 1, minute: 60, hour: 3600, day: 86400 }[match[2]!]!;
  const seconds = amount * multiplier;
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(seconds * 1000)) return invalid();
  return seconds;
}

function timestamp(source: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([Zz]|[+-]\d{2}:\d{2})$/u.exec(
      source,
    );
  if (!match) return invalid();
  const [, year, month, day, hour, minute, second, , offset] = match;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > days[m - 1]! ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    return invalid();
  if (offset!.length > 1 && (Number(offset!.slice(1, 3)) > 23 || Number(offset!.slice(4)) > 59))
    return invalid();
  const time = Date.parse(source.toUpperCase());
  if (!Number.isFinite(time)) return invalid();
  return new Date(time).toISOString();
}

function cronField(
  source: string,
  minimum: number,
  maximum: number,
): { values: number[]; wildcard: boolean } {
  const values = new Set<number>();
  let wildcard = false;
  for (const part of source.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(part);
    if (!match) return invalid();
    const base = match[1]!;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (
      !Number.isSafeInteger(step) ||
      step < 1 ||
      (match[2] && base !== '*' && !base.includes('-'))
    )
      return invalid();
    const bounds = base === '*' ? [minimum, maximum] : base.split('-').map(Number);
    const first = bounds[0]!,
      last = bounds[1] ?? first;
    if (first < minimum || last > maximum || first > last) return invalid();
    wildcard ||= base === '*';
    for (let value = first; value <= last; value += step) values.add(value);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard };
}

function cron(source: string, timezone: string): Extract<AutomationSchedule, { kind: 'cron' }> {
  const parts = source.split(' ');
  if (parts.length !== 5) return invalid();
  const minute = cronField(parts[0]!, 0, 59),
    hour = cronField(parts[1]!, 0, 23);
  const day = cronField(parts[2]!, 1, 31),
    month = cronField(parts[3]!, 1, 12),
    weekday = cronField(parts[4]!, 0, 6);
  if (timezone !== 'native') {
    // intl also accepts fixed offsets; the manifest contract accepts named iana zones only.
    if (/^[+-]/u.test(timezone)) return invalid();
    try {
      timezone = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone;
    } catch {
      return invalid();
    }
  }
  // the gregorian calendar repeats every 400 years; this proves possibility without a clock.
  let possible = false;
  for (let year = 2000; year < 2400 && !possible; year++) {
    for (const selectedMonth of month.values) {
      const count = new Date(Date.UTC(year, selectedMonth, 0)).getUTCDate();
      for (let date = 1; date <= count; date++) {
        const dayMatches = day.values.includes(date);
        const weekdayMatches = weekday.values.includes(
          new Date(Date.UTC(year, selectedMonth - 1, date)).getUTCDay(),
        );
        if (
          day.wildcard || weekday.wildcard
            ? dayMatches && weekdayMatches
            : dayMatches || weekdayMatches
        ) {
          possible = true;
          break;
        }
      }
      if (possible) break;
    }
  }
  if (!possible) return invalid();
  return {
    kind: 'cron',
    fields: {
      minutes: minute.values,
      hours: hour.values,
      days: day.values,
      months: month.values,
      weekdays: weekday.values,
      dayWildcard: day.wildcard,
      weekdayWildcard: weekday.wildcard,
    },
    timezone,
    missedRun: 'native',
  };
}

/** parse shared syntax only; adapters own native support, clocks, and activation anchors. */
export default function normalizeAutomationSchedule(value: unknown): AutomationSchedule {
  if (typeof value === 'string') {
    const source = value.trim().replace(/\s+/gu, ' ');
    if (source.startsWith('every '))
      return { kind: 'every', seconds: duration(source.slice(6)), missedRun: 'native' };
    if (source.startsWith('in '))
      return { kind: 'in', seconds: duration(source.slice(3)), missedRun: 'native' };
    if (/^\d{4}-/u.test(source)) return { kind: 'at', at: timestamp(source), missedRun: 'native' };
    return cron(source, 'native');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.some((key) => !['cron', 'every', 'in', 'at', 'timezone', 'missed-run'].includes(key)))
    return invalid();
  const kinds = ['cron', 'every', 'in', 'at'].filter((key) => Object.hasOwn(object, key));
  if (
    kinds.length !== 1 ||
    (object['missed-run'] !== undefined && object['missed-run'] !== 'native')
  )
    return invalid();
  const kind = kinds[0]!,
    input = object[kind];
  if (typeof input !== 'string' || (kind !== 'cron' && Object.hasOwn(object, 'timezone')))
    return invalid();
  const source = input.trim().replace(/\s+/gu, ' ');
  if (kind === 'cron') {
    const timezone = Object.hasOwn(object, 'timezone') ? object['timezone'] : 'native';
    if (typeof timezone !== 'string' || !timezone.trim()) return invalid();
    return cron(source, timezone);
  }
  if (kind === 'at') return { kind, at: timestamp(source), missedRun: 'native' };
  return { kind: kind as 'every' | 'in', seconds: duration(source), missedRun: 'native' };
}
