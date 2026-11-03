/** Normalize an explicit 12- or 24-hour clock time to minutes after local midnight. */
export default function timeOfDay(value: string): number {
  const source = value
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/([ap])\.m\.?$/u, '$1m');
  const match =
    /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/u.exec(source) ?? /^(\d{2})(\d{2})$/u.exec(source);
  if (!match) throw new Error('Invalid clock time.');
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (minute > 59 || hour > (match[3] ? 12 : 23) || (match[3] && hour < 1))
    throw new Error('Invalid clock time.');
  if (match[3]) hour = (hour % 12) + (match[3] === 'pm' ? 12 : 0);
  return hour * 60 + minute;
}
