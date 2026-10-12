import acknowledgeDispatchDelivery, {
  type DispatchDeliveryContext,
} from './codex-dispatch-delivery.ts';
import codexHeartbeat from './codex-heartbeat.ts';
import prepareDispatchReport from './codex-dispatch-report.ts';
import requireDispatchCheck from './codex-dispatch-check.ts';
import { codexNoticeQueueFull } from './codex-notice-outbox.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';

export default async function reportDispatch(
  input: Record<string, unknown>,
  context: DispatchDeliveryContext & {
    admitted: IntakeState;
    now: number;
  },
) {
  const { state, admitted, intakeStore, now, save } = context;
  if (
    Object.keys(input).some((key) => !['automationId', 'currentTimeIso'].includes(key)) ||
    typeof input.automationId !== 'string' ||
    typeof input.currentTimeIso !== 'string'
  )
    throw new Error('dispatch-request-invalid');
  const run = state.run;
  if (!run) throw new Error('dispatch-native-occurrence-unavailable');
  if (input.automationId !== run.automationId || input.currentTimeIso !== run.currentTimeIso)
    return {
      status: 'continue',
      nextAction: 'report',
      request: {
        action: 'report',
        automationId: run.automationId,
        currentTimeIso: run.currentTimeIso,
      },
      instruction:
        'This report belongs to a different scheduled occurrence. Call report with this exact request; do not finish this turn yet.',
    };
  const quiet = codexHeartbeat({
    automationId: input.automationId,
    currentTimeIso: input.currentTimeIso,
    intake: { status: 'ready', changed: false },
    dispatch: [{ status: 'idle', changed: false }],
  });
  if (quiet.status !== 'quiet') throw new Error('heartbeat-request-invalid');
  const occurrence = Date.parse(input.currentTimeIso);
  if (!Number.isFinite(occurrence)) throw new Error('heartbeat-request-invalid');
  await acknowledgeDispatchDelivery(context);
  const scan = await intakeStore.read();
  if (!scan) throw new Error('dispatch-intake-record-missing');
  const cards = [...(state.notices ?? []), ...(scan.notices ?? [])];
  state.reports = (state.reports ?? []).filter((report) =>
    report.notices.some((id) => cards.some((card) => card.id === id)),
  );
  if (!cards.length) {
    if (
      (admitted.lastAttemptAt ?? 0) < occurrence &&
      (admitted.blocker?.retryAfter ?? 0) <= occurrence
    )
      throw new Error('dispatch-scan-required');
  }
  if (
    run.actions < 12 &&
    !run.stopped &&
    !codexNoticeQueueFull(state.notices) &&
    !codexNoticeQueueFull(scan.notices)
  ) {
    try {
      requireDispatchCheck(state, scan, occurrence);
    } catch {
      await save();
      return {
        status: 'continue',
        nextAction: 'next',
        remainingActions: 12 - run.actions,
        pendingNotices: cards.length,
        instruction:
          'The queue has not reached a stopping point in this scheduled run. Keep the pending cards saved. Call next with the saved projects array, then follow routing-required through prepare and native create_thread/reconcile. Finish only when report returns status report and its response. Do not publish a final answer for status continue.',
      };
    }
  }
  const batch = cards.length
    ? prepareDispatchReport({
        automationId: input.automationId,
        cards,
        reports: state.reports ?? [],
        now,
      })
    : undefined;
  const response = batch?.response ?? quiet.response;
  if (batch) state.reports = [batch];
  await save();
  return { status: 'report', response, pendingNotices: cards.length };
}
