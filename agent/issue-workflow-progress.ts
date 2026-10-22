interface Delivery {
  pullRequest?: { pullRequestNumber: number };
  reconciled?: boolean;
  attached?: boolean;
  cardAttempts?: number;
  pushedHead?: string;
  announcement?: { receipt?: unknown; code?: string };
}
export interface IssueWorkflowState {
  phase: string;
  retired?: unknown;
  retirement?: unknown;
  reset?: unknown;
  handoff?: unknown;
  blocker?: string;
  retry?: unknown;
  result?: { code?: string; outcome?: string };
  progression?: { stage: string; workOwner?: string };
  autoDecision?: { ended?: boolean; code?: string };
  decisionTurn?: { status: string; inactive?: boolean };
  delivery?: Delivery;
  continuation?: {
    message?: string;
    phase?: string;
    code?: string;
    retry?: unknown;
    policyHeld?: string;
    result?: { outcome: string };
    head?: string;
  };
  work?: {
    delivery?: Delivery;
    result?: { outcome: string };
    code?: string;
    turn?: { status: string };
    implementation?: unknown;
    caller?: { runId: string };
    clarificationInput?: { runId: string };
  };
}

type Progress = {
  action: 'assessment' | 'implementation' | 'delivery' | 'wait-input' | 'complete' | 'stopped';
  status: string;
  publicationPending?: boolean;
};

/** unfinished work is shared; native custody and live authorization remain with each host. */
export default function issueWorkflowProgress(record: IssueWorkflowState): Progress {
  if (record.retirement)
    return { action: 'stopped', status: record.retired ? 'retired' : 'retirement-pending' };
  if (
    record.retired ||
    record.reset ||
    record.blocker === 'dispatch-assignment-superseded' ||
    record.result?.code === 'dispatch-assignment-superseded'
  )
    return { action: 'stopped', status: 'obsolete' };
  // openclaw also retains a continuation message; it is transport, not codex work state.
  const continuation = record.continuation?.phase ? record.continuation : undefined;
  const work = record.work;
  if (continuation?.phase === 'cancelled')
    return record.handoff
      ? { action: 'implementation', status: 'running' }
      : { action: 'stopped', status: 'cancelled' };
  if (
    continuation?.phase === 'blocked' ||
    (work?.code &&
      ![
        'implementation-result-missing',
        'implementation-delivery-incomplete',
        'dispatch-turn-failed',
      ].includes(work.code))
  )
    return { action: 'stopped', status: 'blocked' };
  const result = continuation?.result ?? work?.result;
  // a refreshed native context has already verified the answer before recording this resume.
  const resumed = continuation
    ? continuation.phase === 'running'
    : Boolean(
        work?.clarificationInput &&
        work.caller &&
        work.caller.runId !== work.clarificationInput.runId,
      );
  if (
    (result?.outcome === 'clarification-needed' && !resumed) ||
    continuation?.phase === 'clarification-needed'
  )
    return { action: 'wait-input', status: 'clarification-needed' };
  if (result?.outcome === 'blocked' && !resumed) return { action: 'wait-input', status: 'blocked' };
  const delivery = record.delivery ?? work?.delivery;
  const implementing =
    (result && result.outcome !== 'done' && resumed) ||
    (!result &&
      (work?.implementation ||
        work?.turn ||
        (continuation && !['delivery', 'complete'].includes(continuation.phase!))));
  if (!implementing && (result?.outcome === 'done' || delivery?.pullRequest)) {
    const published =
      delivery?.pullRequest &&
      delivery.reconciled &&
      (!continuation?.head || delivery.pushedHead === continuation.head);
    const complete =
      published &&
      delivery.attached !== false &&
      delivery.cardAttempts !== 0 &&
      delivery.announcement?.receipt &&
      !delivery.announcement.code;
    return complete
      ? { action: 'complete', status: 'complete' }
      : {
          action: 'delivery',
          status: delivery?.pullRequest ? 'partially-delivered' : 'delivery',
          publicationPending: !published,
        };
  }
  if (record.progression?.stage !== 'implementation') {
    if (record.autoDecision && !record.autoDecision.ended)
      return { action: 'assessment', status: record.autoDecision.code ? 'blocked' : 'assessing' };
    if (record.decisionTurn && record.decisionTurn.status !== 'completed')
      return {
        action: 'assessment',
        status: record.decisionTurn.inactive ? 'blocked' : 'assessing',
      };
  }
  if (continuation) {
    if (continuation.phase === 'complete')
      return { action: 'wait-input', status: 'result-missing' };
    return {
      action: continuation.phase === 'delivery' ? 'delivery' : 'implementation',
      ...(continuation.phase === 'delivery' ? { publicationPending: true } : {}),
      status: continuation.policyHeld
        ? 'policy-held'
        : continuation.retry
          ? 'retrying'
          : (continuation.phase ?? 'running'),
    };
  }
  if (work || record.progression?.stage === 'implementation') {
    return {
      action: 'implementation',
      status:
        work?.code === 'implementation-result-missing'
          ? 'result-missing'
          : work?.code === 'implementation-delivery-incomplete'
            ? 'delivery'
            : work?.turn?.status === 'attempted'
              ? 'uncertain'
              : work?.turn?.status === 'accepted'
                ? 'prepared'
                : 'running',
    };
  }
  if (record.result?.outcome === 'clarification-needed')
    return { action: 'wait-input', status: 'clarification-needed' };
  return {
    action: 'assessment',
    status:
      record.phase === 'blocked'
        ? 'blocked'
        : record.retry
          ? 'retrying'
          : record.phase === 'complete'
            ? (record.result?.outcome ?? record.phase)
            : record.phase === 'creating'
              ? 'uncertain'
              : record.phase,
  };
}
