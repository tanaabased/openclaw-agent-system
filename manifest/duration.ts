/** Normalize explicit duration units to seconds without guessing a bare number's unit. */
export default function duration(value: string): number {
  const source = value.trim().toLowerCase();
  const units: Record<string, number> = {
    s: 1,
    sec: 1,
    secs: 1,
    second: 1,
    seconds: 1,
    m: 60,
    min: 60,
    mins: 60,
    minute: 60,
    minutes: 60,
    h: 3600,
    hr: 3600,
    hrs: 3600,
    hour: 3600,
    hours: 3600,
    d: 86400,
    day: 86400,
    days: 86400,
  };
  let seconds = 0;
  let offset = 0;
  for (const match of source.matchAll(/(\d+)\s*([a-z]+)/gu)) {
    if (source.slice(offset, match.index).trim() || !units[match[2]!])
      throw new Error('Invalid duration.');
    seconds += Number(match[1]) * units[match[2]!]!;
    offset = match.index! + match[0].length;
  }
  if (source.slice(offset).trim() || seconds <= 0 || !Number.isSafeInteger(seconds * 1000))
    throw new Error('Invalid duration.');
  return seconds;
}
