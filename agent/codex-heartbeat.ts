import { nativeObject } from './automation-gateway.ts';
import { automationHash } from './automation-hash.ts';

export const codexQuietHeartbeatInstructions =
  'For quiet issue-intake heartbeats, use intakeRuntime.argvPrefix from the newest trusted Agent System context followed by quiet-response --plugin-data and intakeRuntime.pluginData. Send JSON on stdin with automationId and currentTimeIso copied from the current native trigger automation_id and current_time_iso, intake as an object with status and changed from the scan, and dispatch as an array of objects with status and changed from every dispatch outcome in the entire loop. Never use the manifest job key as automationId or the completion clock as currentTimeIso. When status is quiet, copy response verbatim as the entire final response: it preserves DONT_NOTIFY and puts the chosen text only inside the native heartbeat message. Emit no prose outside that envelope. When status is not-quiet, keep the existing reporting rules and native heartbeat contract; never replace required approval, failures, recovery, or changed-work notices with playful text. A final idle result never cancels earlier notices. Do not invoke the formatter after a failed tool call or interruption.';

const messages = {
  morning: [
    '☕ Morning watch complete. No new update needs your attention.',
    '🌅 Morning check: no new update for you. Coffee may proceed.',
    '🐓 The morning patrol has nothing new to report.',
    '🥐 Morning check: no new update. Second breakfast is still on the menu.',
    '⏰ Morning check: no new update. Groundhog Day, minus the existential crisis.',
  ],
  afternoon: [
    '☀️ Afternoon watch complete. No new update needs your attention.',
    '🫖 Afternoon check: nothing new to report. Tea remains an option.',
    '📬 The afternoon patrol has no new update for you.',
    '🎩 Afternoon check: no new update. The Mad Hatter can pour another cup.',
    '🛋️ Afternoon check: no new update. Ferris Bueller would approve of this break.',
  ],
  evening: [
    '🌆 Evening watch complete. No new update needs your attention.',
    '🌇 Evening check: no new update for you. Carry on with your evening.',
    '🍽️ The evening patrol has nothing new to report.',
    '🏜️ Evening check: no new update. Cue the binary sunset.',
    '📖 Evening check: no new update. Let us go then, you and I—to dinner.',
  ],
  night: [
    '🌙 Night watch complete. No new update needs your attention.',
    '🦉 Night check: nothing new to report. The owl remains on duty.',
    '🔭 The night patrol has no new update for you.',
    '🛡️ Night gathers. The Night’s Watch has no new update for you.',
    '🕯️ Night check: no new update. No raging against the dying light required.',
  ],
} as const;

function outcome(value: unknown): value is { status: string; changed: boolean } {
  return (
    nativeObject(value) &&
    Object.keys(value).every((key) => ['status', 'changed'].includes(key)) &&
    typeof value.status === 'string' &&
    typeof value.changed === 'boolean'
  );
}

function escaped(value: string) {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** format successful quiet polling only; the caller still owns notices and workflow decisions. */
export default function codexHeartbeat(request: unknown, timeZone?: string) {
  if (
    !nativeObject(request) ||
    Object.keys(request).some(
      (key) => !['automationId', 'currentTimeIso', 'intake', 'dispatch'].includes(key),
    ) ||
    typeof request.automationId !== 'string' ||
    !request.automationId.trim() ||
    request.automationId !== request.automationId.trim() ||
    request.automationId.length > 256 ||
    !outcome(request.intake) ||
    !Array.isArray(request.dispatch) ||
    !request.dispatch.length ||
    request.dispatch.length > 12 ||
    !request.dispatch.every(outcome)
  )
    throw new Error('heartbeat-request-invalid');

  const dispatch = request.dispatch;
  if (
    request.intake.status !== 'ready' ||
    request.intake.changed ||
    dispatch.some(
      (result) =>
        result.changed || !['idle', 'at-capacity', 'creating', 'busy'].includes(result.status),
    ) ||
    dispatch.at(-1)!.status === 'busy'
  )
    return { status: 'not-quiet' as const };

  // the native trigger emits a canonical utc timestamp; never substitute the completion clock.
  const timestamp =
    typeof request.currentTimeIso === 'string' ? Date.parse(request.currentTimeIso) : NaN;
  const date = new Date(timestamp);
  const validTime = Number.isFinite(timestamp) && date.toISOString() === request.currentTimeIso;
  const hour = validTime
    ? Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          hour: 'numeric',
          hourCycle: 'h23',
        })
          .formatToParts(date)
          .find((part) => part.type === 'hour')!.value,
      )
    : null;
  const period =
    hour === null
      ? null
      : hour >= 5 && hour < 12
        ? 'morning'
        : hour >= 12 && hour < 17
          ? 'afternoon'
          : hour >= 17 && hour < 22
            ? 'evening'
            : 'night';
  const collection = period ? messages[period] : null;
  const index = collection
    ? Number.parseInt(automationHash(timestamp).slice(0, 8), 16) % collection.length
    : 0;
  const message = collection ? collection[index]! : 'No new update needs your attention.';
  return {
    status: 'quiet' as const,
    period,
    message,
    response: [
      '<heartbeat>',
      `  <automation_id>${escaped(request.automationId)}</automation_id>`,
      '  <decision>DONT_NOTIFY</decision>',
      `  <message>${escaped(message)}</message>`,
      '</heartbeat>',
    ].join('\n'),
  };
}
