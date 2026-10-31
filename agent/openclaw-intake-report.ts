import { dispatchStorageNotice } from './dispatch-storage.ts';
import intakeDebug from './intake-debug.ts';
import retirementNotice from './retirement-notice.ts';
import workflowRecovery from './workflow-recovery.ts';
import workflowStatus from './workflow-status.ts';
import { automationHash } from './automation-hash.ts';
import dispatchCapacity from './openclaw-capacity.ts';
import pendingAssignments from './dispatch-pending.ts';
import intakeAutomationNotice from '../channels/github/presentation/intake-automation-notice.ts';
import type { OpenClawDispatchState, OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { intakeRemediation, type IntakeState } from '../channels/github/intake/record-store.ts';
import {
  githubNotificationMarkdownCode as inlineCode,
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
  debug?: boolean;
}) {
  const { state, intake, observation } = input;
  const storage = dispatchStorageNotice(state);
  const active = state.records.filter(
    (record) => !record.retired && !record.retirement && !record.reset,
  );
  const retiring = state.records.filter(
    (record) => record.retirement && !record.retired && !record.reset,
  );
  const retirementPending = retiring.length;
  const retirementNotices = state.records
    .filter((record) => !record.reset && !record.retired && record.retirement?.code)
    .map((record) => {
      const code = record.retirement!.code!;
      return {
        record,
        code,
        notice:
          retirementNotice(code, record.retirement?.diagnostic) ??
          retirementNotice('retirement-check-unavailable')!,
      };
    });
  const managing = active.filter((record) => record.sessionCreation?.verified && record.threadId);
  const capacity = dispatchCapacity(state.records, input.slots, state.projectPickup);
  const started = managing.filter((record) => record.intakeReportedAt === undefined).slice(0, 12);
  const pending =
    intake && observation.status === 'ready' ? pendingAssignments(state, intake).length : undefined;
  const failures = [
    ...(storage.level !== 'normal' ? [{ id: 'storage', code: storage.key }] : []),
    ...retirementNotices
      .filter(({ notice }) => notice.severity !== 'info')
      .map(({ record, code }) => ({ id: record.id, code })),
    ...(observation.status === 'blocked'
      ? [{ id: 'intake', code: observation.code ?? 'intake-check-incomplete' }]
      : []),
    ...(intake?.deferred ?? []).map((entry) => ({ id: 'deferred-' + entry.key, code: entry.code })),
    ...managing
      .filter((record) => record.feedback?.code)
      .map((record) => ({
        id: 'feedback-' + record.id,
        code: record.feedback!.code!,
      })),
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
    if (problem.endsWith(':retirement-legacy-unverified') || problems.includes(problem))
      return false;
    const id = problem.slice(0, problem.indexOf(':'));
    if (id === 'storage') return storage.level === 'normal';
    if (id === 'intake') return observation.status === 'ready';
    if (id.startsWith('deferred-')) return true;
    if (id.startsWith('feedback-'))
      return Boolean(active.find((record) => record.id === id.slice(9) && !record.feedback?.code));
    const retired = state.records.find(
      (entry) => entry.id === id && (entry.retirement || entry.retired),
    );
    if (retired)
      return (
        !retired.retirement?.code ||
        Boolean(retired.retired) ||
        retirementNotice(retired.retirement.code)?.severity === 'info'
      );
    const record = active.find((entry) => entry.id === id);
    return Boolean(record && !record.blocker);
  });
  const fingerprintFacts = {
    problems,
    managing: managing.length,
    pending: pending ?? null,
    capacity,
  };
  const fingerprint = automationHash(fingerprintFacts);
  const previousProblems = state.intakeReport?.problems ?? [];
  const reclassifiedOnly =
    previousProblems.some((p) => p.endsWith(':retirement-legacy-unverified')) &&
    JSON.stringify(previousProblems.filter((p) => !p.endsWith(':retirement-legacy-unverified'))) ===
      JSON.stringify(problems) &&
    state.intakeReport?.fingerprint ===
      automationHash({ ...fingerprintFacts, problems: previousProblems });
  const changed =
    started.length > 0 ||
    (!reclassifiedOnly &&
      fingerprint !== state.intakeReport?.fingerprint &&
      (Boolean(state.intakeReport) || problems.length > 0 || Boolean(pending)));
  const automationNotice = intakeAutomationNotice(observation.code ?? '');
  const title =
    automationNotice && failures.length === 1
      ? `${automationNotice.emoji} ${automationNotice.title}`
      : failures.length
        ? observation.status === 'blocked'
          ? '⚠️ Intake needs attention'
          : '⚠️ Intake checked — some items need attention'
        : started.length
          ? `💡 Intake complete — ${started.length} issue${started.length === 1 ? '' : 's'} started`
          : recovered.length
            ? recovered.some((problem) =>
                state.records.some(
                  (record) => problem.startsWith(record.id + ':') && record.retirement,
                ),
              )
              ? '💡 Retirement blocker cleared'
              : '💡 Intake resumed'
            : retirementNotices.length
              ? '💡 Intake checked — retirement in progress'
              : '💡 Intake checked';
  const lines = ['## ' + title, ''];
  if (storage.level !== 'normal' || recovered.some((entry) => entry.startsWith('storage:')))
    lines.push(
      storage.message,
      storage.level === 'normal'
        ? 'Journal pressure is clear.'
        : 'Reconcile retired history. New admissions pause at 32 MiB; existing tasks can continue within the emergency budget.',
      '',
    );
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
    if (failure.id === 'storage') continue;
    const notice = intakeAutomationNotice(failure.code);
    if (failure.id === 'intake' && notice) {
      lines.push(
        `- **What happened:** ${notice.summary}`,
        `- **Next step:** ${notice.next}`,
        `- **Technical detail:** ${inlineCode(failure.code)}`,
      );
      continue;
    }
    const retiring = retirementNotices.find(({ record }) => record.id === failure.id);
    if (retiring) {
      lines.push(
        `- **Issue:** ${text(label(retiring.record))}`,
        `  **Operation:** retirement cleanup`,
        `  **What happened:** ${retiring.notice.summary}`,
        `  **Action:** ${retiring.notice.next}`,
        `  **Diagnostic:** ${inlineCode(failure.code)}`,
      );
      continue;
    }
    const provider =
      failure.id === 'intake'
        ? intake?.blocker?.providerDiagnostic
        : intake?.deferred?.find((entry) => 'deferred-' + entry.key === failure.id)
            ?.providerDiagnostic;
    if (provider)
      lines.push(
        `- **Provider:** ${text(provider.provider)} · ${inlineCode(provider.operation)}${provider.httpStatus ? ' · HTTP ' + provider.httpStatus : ''}`,
        `  **Detail:** ${text(provider.providerMessage ?? provider.explanation)}`,
      );
    const deferred = intake?.deferred?.find((entry) => 'deferred-' + entry.key === failure.id);
    if (deferred) {
      const candidate = JSON.parse(deferred.candidate) as {
        repositoryPath: string;
        number: number;
      };
      lines.push(
        `- **Issue:** ${text(candidate.repositoryPath.replace('/repos/', '') + '#' + candidate.number)}`,
        `  **Diagnostic:** ${inlineCode(deferred.code)}`,
        '  **Action:** This assignment will be checked again on a later scan. Unrelated intake continues.',
      );
      continue;
    }
    const automation = failure.code.startsWith('automation-');
    if (failure.id.startsWith('feedback-')) {
      const record = managing.find((record) => record.id === failure.id.slice(9))!;
      const item = intake?.records.find((entry) => entry.id === record.intakeId);
      const pr = record.work?.delivery?.pullRequest;
      const stalls = Object.entries(record.feedback?.discoveryStalls ?? {}).filter(
        ([, stall]) => stall.attempts >= 3,
      );
      lines.push(`- **Issue:** ${text(label(record))}`);
      for (const [nodeId, stall] of stalls) {
        const number = nodeId === pr?.pullRequestNodeId ? pr.pullRequestNumber : item?.issue.number;
        const kind = nodeId === pr?.pullRequestNodeId ? 'pull' : 'issues';
        const url =
          item && number
            ? `https://github.com/${item.repository.owner.login}/${item.repository.name}/${kind}/${number}`
            : undefined;
        lines.push(
          `  **Source:** ${url ? `[${kind === 'pull' ? 'PR' : 'Issue'} #${number}](${url})` : text(label(record))}`,
          `  **Operation:** ${inlineCode(stall.operation)}`,
        );
      }
      lines.push(
        `  **Diagnostic:** ${inlineCode(failure.code)}`,
        '  **Action:** Later bounded checks retry automatically. If this persists, inspect the named operation and provider access or latency. Preserve the saved checkpoint; do not reset or replay.',
      );
      continue;
    }
    const record = active.find((record) => record.id === failure.id);
    const retry = record?.retry ? record.retryAfter : undefined;
    lines.push(
      ...(record
        ? [
            `- **Issue:** ${text(label(record))}`,
            `  **Operation:** ${text(record.failureStage ?? 'assignment preparation')}`,
            `  **Status:** ${workflowStatus(record)}`,
          ]
        : ['- **Operation:** assignment scan']),
      `- **Diagnostic:** ${inlineCode(failure.code)}`,
      '  **Action:** ' +
        (retry
          ? 'Automatic recovery will retry at or after ' +
            new Date(retry).toISOString() +
            '. Preserve the retained request; no new stage approval is needed.'
          : automation
            ? /sync|required|disabled|ownership/.test(failure.code)
              ? 'Run Agent System Install to reconcile the owned intake automation. Nothing was repaired automatically.'
              : 'Inspect the intake automation execution and delivery health with supported Agent System Doctor. Preserve its receipts; retry observation when service access is available.'
            : (workflowRecovery(failure.code)?.next ?? intakeRemediation(failure.code))),
    );
  }
  for (const { record, notice } of retirementNotices
    .filter(({ notice }) => notice.severity === 'info')
    .slice(0, 12))
    lines.push(
      `- **Issue:** ${text(label(record))}`,
      `  **What happened:** ${notice.summary}`,
      `  **Next step:** ${notice.next}`,
    );
  if (failures.length) lines.push('');
  if (recovered.length)
    lines.push(
      'The earlier intake condition has cleared: ' +
        recovered.map((p) => '`' + text(p.slice(p.indexOf(':') + 1)) + '`').join(', ') +
        '.',
      '',
    );
  lines.push(
    `**Active:** ${managing.length} issues${pending === undefined ? '' : ` · **Pending:** ${pending}`}`,
    `**Retirement pending:** ${retirementPending}`,
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
    response: [
      githubNotificationQuote(lines.join('\n')),
      intakeDebug(input.debug, state.records, label),
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}
