import type { AutomationSchedule } from '../manifest/automation-schedule.ts';

/** Filter a generated cron superset before OpenClaw starts its model payload. */
export default function scheduleCondition(
  schedule: AutomationSchedule,
  timezone: string,
  script?: string,
) {
  if (schedule.kind !== 'cron' || !schedule.times) return script;
  if (schedule.times.length === schedule.fields.hours.length * schedule.fields.minutes.length)
    return script;
  return [
    `const parts = new Intl.DateTimeFormat('en-GB', {timeZone:${JSON.stringify(schedule.timezone ?? timezone)},hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());`,
    `const minute = Number(parts.find(p=>p.type==='hour').value)*60 + Number(parts.find(p=>p.type==='minute').value);`,
    `if (${JSON.stringify(schedule.times)}.includes(minute)) { ${script ?? 'json({fire:true});'} } else { json({fire:false}); }`,
  ].join('\n');
}
