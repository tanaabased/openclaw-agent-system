import { automationHash } from './automation-hash.ts';
import { codexHeartbeatEnvelope } from './codex-heartbeat.ts';
import type { CodexNotice } from './codex-notice-outbox.ts';
import type { DispatchState } from './codex-dispatch-state.ts';

export const reportNoticeLimit = 100;
export const reportResponseLimit = 128000;

/** Freeze a bounded batch until delivery; new cards cannot change an outstanding receipt. */
export default function prepareDispatchReport(input: {
  automationId: string;
  cards: CodexNotice[];
  reports: NonNullable<DispatchState['reports']>;
  now: number;
}) {
  const ids = new Set(input.cards.map((card) => card.id));
  const retained = input.reports.find(
    (report) =>
      report.automationId === input.automationId && report.notices.some((id) => ids.has(id)),
  );
  if (retained) return retained;
  const batch: CodexNotice[] = [];
  let response = '';
  for (const card of input.cards) {
    const candidate = [...batch, card];
    // The hidden batch marker distinguishes identical-looking plan revisions in native history.
    const marker = automationHash(candidate.map((entry) => entry.id));
    const rendered = codexHeartbeatEnvelope(
      input.automationId,
      candidate.map((entry) => entry.message).join('\n\n') + `\n\n<!-- notice-batch:${marker} -->`,
      candidate.some((entry) => entry.notify),
    );
    if (candidate.length > reportNoticeLimit || Buffer.byteLength(rendered) > reportResponseLimit)
      break;
    batch.push(card);
    response = rendered;
  }
  if (!batch.length) throw new Error('dispatch-report-capacity');
  return {
    response,
    automationId: input.automationId,
    createdAt: input.now,
    notices: batch.map((card) => card.id),
  };
}
