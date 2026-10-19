interface Delivery {
  pullRequest?: { pullRequestNumber: number };
  reconciled?: boolean;
  attached?: boolean;
  announcement?: { receipt?: unknown };
}
interface State {
  phase: string;
  retired?: unknown;
  retirement?: unknown;
  reset?: unknown;
  blocker?: string;
  retry?: unknown;
  result?: { code?: string; outcome?: string };
  continuation?: { phase?: string; code?: string; retry?: unknown; message?: string };
  progression?: { stage: string };
  delivery?: Delivery;
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

/** presentation follows retained evidence; it never grants authority or releases capacity. */
export default function workflowStatus(record: State) {
  if (record.retirement) return record.retired ? 'retired' : 'retirement-pending';
  if (
    record.retired ||
    record.reset ||
    record.blocker === 'dispatch-assignment-superseded' ||
    record.result?.code === 'dispatch-assignment-superseded'
  )
    return 'obsolete';
  const delivery = record.delivery ?? record.work?.delivery;
  if (
    delivery?.pullRequest &&
    (!delivery.reconciled || delivery.attached === false || !delivery.announcement?.receipt)
  )
    return 'partially-delivered';
  if (record.work?.code || record.work?.result?.outcome === 'blocked') return 'blocked';
  const failure = record.continuation ?? record;
  if (failure.phase === 'blocked' || failure.phase === 'cancelled') return 'blocked';
  if (failure.retry) return 'retrying';
  if (record.continuation) return record.continuation.phase ?? record.phase;
  const work = record.work;
  if (work?.result?.outcome === 'clarification-needed')
    return work.clarificationInput &&
      work.caller &&
      work.caller.runId !== work.clarificationInput.runId
      ? 'running'
      : 'clarification-needed';
  if (delivery?.pullRequest) return 'complete';
  if (work?.result?.outcome === 'done') return 'delivery';
  if (work?.turn?.status === 'attempted') return 'uncertain';
  if (work?.turn?.status === 'accepted') return 'prepared';
  if (work?.turn || work?.implementation || record.progression?.stage === 'implementation')
    return 'running';
  if (record.phase === 'complete') return record.result?.outcome ?? record.phase;
  return record.phase === 'creating' ? 'uncertain' : record.phase;
}
