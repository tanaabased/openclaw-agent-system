import acknowledgeDispatchDelivery, {
  type DispatchDeliveryContext,
} from './codex-dispatch-delivery.ts';
import codexHeartbeat from './codex-heartbeat.ts';
import prepareDispatchReport from './codex-dispatch-report.ts';
import requireDispatchCheck from './codex-dispatch-check.ts';
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
    // Pending delivery may drain without another provider scan; quiet completion may not.
    if (
      (admitted.lastAttemptAt ?? 0) < occurrence &&
      (admitted.blocker?.retryAfter ?? 0) <= occurrence
    )
      throw new Error('dispatch-scan-required');
    requireDispatchCheck(state, scan, occurrence);
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
