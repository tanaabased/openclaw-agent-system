import { nativeObject } from './automation-gateway.ts';
import { automationHash } from './automation-hash.ts';

export const codexQuietHeartbeatInstructions =
  'For scheduled issue intake, finish the current scan and pending creation work, then call dispatchRuntime action:report with automationId and currentTimeIso from this native trigger. Follow status continue before finishing. For status report, use its response as the final heartbeat. It summarizes intake only: issues started, pending assignments, occupied slots, and intake obstacles. Plans, questions, assessment failures, and implementation progress belong in the individual issue. Quiet reports use DONT_NOTIFY. Presentation differences never change assignment or creation state. After a failed command, follow the bounded native host-access retry; if it still fails, use intakeRuntime failure-response with the actual diagnostic and approval reason. Never describe a failed check as quiet success.';

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
    '🛡️ Night gathers. Nothing new to report—and so my watch has ended. Next watch in about five minutes.',
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

/** render exactly one native envelope for both quiet updates and actionable cards. */
export function codexHeartbeatEnvelope(automationId: string, message: string, notify: boolean) {
  if (!automationId.trim() || automationId.length > 256)
    throw new Error('heartbeat-request-invalid');
  return [
    '<heartbeat>',
    `  <automation_id>${escaped(automationId)}</automation_id>`,
    `  <decision>${notify ? 'NOTIFY' : 'DONT_NOTIFY'}</decision>`,
    `  <message>${message}</message>`,
    '</heartbeat>',
  ].join('\n');
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
    !['ready', 'blocked'].includes(request.intake.status) ||
    request.intake.changed ||
    dispatch.some(
      (result) =>
        result.changed ||
        !['idle', 'at-capacity', 'creating', 'busy', 'assessing', 'handed-off', 'blocked'].includes(
          result.status,
        ),
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
    response: codexHeartbeatEnvelope(request.automationId, message, false),
  };
}
