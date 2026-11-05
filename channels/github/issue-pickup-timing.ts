import duration from '../../manifest/duration.ts';
import timeOfDay from '../../manifest/time-of-day.ts';
import normalize, { type AutomationSchedule } from '../../manifest/automation-schedule.ts';

export const maximumPickupWindowMs = 86_400_000;

export interface PickupTimingInput {
  start?: string;
  window?: string;
  duration?: string;
  end?: string;
  scans?: number;
}

/** Normalize the daily pickup clock, duration and scan count. */
export default function pickupTiming(value: PickupTimingInput): {
  schedule: AutomationSchedule;
  windowMinutes: number;
  scanSchedule: AutomationSchedule;
} {
  const start = timeOfDay(value.start ?? '03:00');
  const windows = [value.window, value.duration]
    .filter((v): v is string => v !== undefined)
    .map(duration);
  if (value.end !== undefined)
    windows.push(((timeOfDay(value.end) - start + 1440) % 1440 || 1440) * 60);
  if (windows.some((v) => v !== windows[0])) throw new Error('issue-pickup-timing-conflict');
  const seconds = windows[0] ?? 7200;
  const scans = value.scans ?? 8;
  if (
    seconds > maximumPickupWindowMs / 1000 ||
    !Number.isInteger(scans) ||
    scans < 1 ||
    (scans > 1 && scans > seconds / 60)
  )
    throw new Error('issue-pickup-schedule-precision');
  const windowMinutes = seconds / 60;
  const times = Array.from(
    { length: scans },
    (_, index) => (start + Math.floor((index * windowMinutes) / scans)) % 1440,
  ).sort((a, b) => a - b);
  const minutes = [...new Set(times.map((t) => t % 60))].sort((a, b) => a - b);
  const hours = [...new Set(times.map((t) => Math.floor(t / 60)))].sort((a, b) => a - b);
  const scanSchedule = normalize(`${minutes.join(',')} ${hours.join(',')} * * *`);
  if (scanSchedule.kind !== 'cron') throw new Error('issue-pickup-schedule-unsupported');
  scanSchedule.times = times;
  return {
    schedule: normalize(`${start % 60} ${Math.floor(start / 60)} * * *`),
    windowMinutes,
    scanSchedule,
  };
}
