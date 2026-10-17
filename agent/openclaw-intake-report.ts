import { automationHash } from './automation-hash.ts';
import dispatchCapacity from './dispatch-capacity.ts';
import pendingAssignments from './dispatch-pending.ts';
import type { OpenClawDispatchState, OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { intakeRemediation, type IntakeState } from '../channels/github/intake/record-store.ts';
import {
  githubNotificationMarkdownText as text,
  githubNotificationQuote,
} from '../channels/github/presentation/card.ts';

export interface IntakeObservation {
  status: 'ready' | 'blocked';
  changed: boolean;
  code?: string;
}

/** presentation metadata never selects work, releases capacity, or proves delivery. */
export default function openclawIntakeReport(input: {
  state: OpenClawDispatchState;
  intake?: IntakeState;
  observation: IntakeObservation;
  slots: number;
}) {
  const { state, intake, observation } = input;
  const active = state.records.filter((record) => !record.retired && !record.reset);
  const managing = active.filter((record) => record.sessionCreation?.verified && record.threadId);
  const capacity = dispatchCapacity(active, input.slots);
  const started = managing.filter((record) => record.intakeReportedAt === undefined).slice(0, 12);
  const pending =
    intake && observation.status === 'ready' ? pendingAssignments(state, intake).length : undefined;
  const failures = [
    ...(observation.status === 'blocked'
      ? [{ id: 'intake', code: observation.code ?? 'intake-check-incomplete' }]
      : []),
    ...active
      .filter(
        (record) =>
          record.blocker &&
          !record.handoff &&
          !record.result &&
          (!record.sessionCreation?.verified ||
            record.failureStage === 'first-turn' ||
            (record.failureStage === 'assessment-turn' &&
              record.blocker.startsWith('dispatch-turn-'))),
      )
      .map((record) => ({ id: record.id, code: record.blocker! })),
  ].sort((a, b) => (a.id + a.code).localeCompare(b.id + b.code));
  const problems = failures.map(({ id, code }) => id + ':' + code);
  const recovered = (state.intakeReport?.problems ?? []).filter((problem) => {
    if (problems.includes(problem)) return false;
    const id = problem.slice(0, problem.indexOf(':'));
    if (id === 'intake') return observation.status === 'ready';
    const record = active.find((entry) => entry.id === id);
    return Boolean(record && !record.blocker);
  });
  const fingerprint = automationHash({
    problems,
    managing: managing.length,
    pending: pending ?? null,
    capacity,
  });
  const changed =
    started.length > 0 ||
    (fingerprint !== state.intakeReport?.fingerprint &&
      (Boolean(state.intakeReport) || problems.length > 0 || Boolean(pending)));
  const title = failures.length
    ? '⚠️ Intake needs attention'
    : started.length
      ? `ℹ️ Intake complete — ${started.length} issue${started.length === 1 ? '' : 's'} started`
      : recovered.length
        ? 'ℹ️ Intake resumed'
        : 'ℹ️ Intake checked';
  const lines = ['## ' + title, ''];
  const label = (record: OpenClawDispatchRecord) => {
    const item = intake?.records.find((entry) => entry.id === record.intakeId);
    return item
      ? `${item.repository.owner.login}/${item.repository.name}#${item.issue.number}`
      : 'Issue';
  };
  for (const record of started)
    lines.push(
      `- **Issue:** [${text(label(record))}](/chat?session=${encodeURIComponent(record.threadId!)})`,
    );
  if (started.length) lines.push('');
  for (const failure of failures.slice(0, 12)) {
    const automation = failure.code.startsWith('automation-');
    lines.push(
      `- **Diagnostic:** \`${text(failure.code)}\``,
      '  **Action:** ' +
        (automation
          ? /sync|required|disabled|ownership/.test(failure.code)
            ? 'Run Agent System Install to reconcile the owned intake automation. Nothing was repaired automatically.'
            : 'Inspect the intake automation execution and delivery health with supported Agent System Doctor. Preserve its receipts; retry observation when service access is available.'
          : intakeRemediation(failure.code)),
    );
  }
  if (failures.length) lines.push('');
  if (recovered.length)
    lines.push(
      'The earlier intake condition has cleared: ' +
        recovered.map((p) => '`' + text(p.slice(p.indexOf(':') + 1)) + '`').join(', ') +
        '.',
      '',
    );
  lines.push(
    `**Managing:** ${managing.length} issues${pending === undefined ? '' : ` · **Pending:** ${pending}`}`,
    `**Slots:** ${capacity.occupied}/${input.slots} occupied · ${capacity.available} available`,
  );
  if (pending && !capacity.available)
    lines.push('Pending issues will start when a slot becomes available.');
  if (observation.status === 'blocked')
    lines.push('The check is incomplete; pending assignments are unknown.');
  return {
    changed,
    fingerprint,
    problems,
    started: started.map((record) => record.id),
    response: githubNotificationQuote(lines.join('\n')),
  };
}
