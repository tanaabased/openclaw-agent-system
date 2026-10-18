import prepareDispatchReport from './codex-dispatch-report.ts';
import requireDispatchCheck from './codex-dispatch-check.ts';
import type { DispatchState } from './codex-dispatch-state.ts';
import type IntakeRecordStore from '../channels/github/intake/record-store.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';

export default async function reportDispatch(
  input: Record<string, unknown>,
  context: {
    state: DispatchState;
    admitted: IntakeState;
    intakeStore: IntakeRecordStore;
    now: number;
    slots: number;
    save(): Promise<void>;
  },
) {
  const { state, intakeStore, now, save, slots } = context;
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
      instruction: 'Call report with this scheduled occurrence; do not finish yet.',
    };
  if (run.response) return { status: 'report', response: run.response };
  const occurrence = Date.parse(input.currentTimeIso);
  if (!Number.isFinite(occurrence)) throw new Error('heartbeat-request-invalid');
  const scan = await intakeStore.read();
  if (!scan) throw new Error('dispatch-intake-record-missing');
  if ((scan.lastAttemptAt ?? 0) < occurrence && (scan.blocker?.retryAfter ?? 0) <= occurrence)
    throw new Error('dispatch-scan-required');
  if (run.actions < 12 && !run.stopped && !scan.blocker) {
    try {
      requireDispatchCheck(state, scan, occurrence);
    } catch {
      return {
        status: 'continue',
        nextAction: 'next',
        remainingActions: 12 - run.actions,
        instruction:
          'Finish checking pending assignments with next, prepare, and native creation/reconcile before reporting. Do not wait for assessments or announce their progress.',
      };
    }
  }
  const pendingDiscovery = Boolean(
    scan.discovery ||
    state.discoveryCycleAt ||
    state.records.some(
      (r) =>
        !r.retired &&
        !r.reset &&
        (r.feedback?.discoveryPending || Object.keys(r.feedback?.discovery ?? {}).length),
    ),
  );
  if (pendingDiscovery || state.discoveryProgress)
    state.discoveryProgress = {
      pending: pendingDiscovery,
      sources: state.records.filter((r) => !r.retired && !r.reset && r.threadId).length,
      ...(state.discoveryProgress?.pending === pendingDiscovery
        ? { reported: state.discoveryProgress.reported }
        : {}),
    };
  const report = prepareDispatchReport({
    state,
    intake: scan,
    slots,
    automationId: input.automationId,
    currentTimeIso: input.currentTimeIso,
  });
  for (const record of state.records)
    if (report.started.includes(record.id)) record.intakeReportedAt = now;
  for (const record of state.records)
    for (const event of record.feedback?.events ?? [])
      if (report.sent.includes(event.id)) event.reported = true;
  if (state.discoveryProgress) state.discoveryProgress.reported = state.discoveryProgress.pending;
  state.intakeHealth = report.health;
  // this is a report attempt, not proof of delivery; prose never gates new assignments.
  run.response = report.response;
  await save();
  return { status: 'report', response: report.response };
}
