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
  delivery?: Delivery;
  work?: { delivery?: Delivery; result?: { outcome: string }; code?: string };
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
  if (
    record.continuation?.phase === 'clarification-needed' ||
    (record.work?.result?.outcome === 'clarification-needed' && !record.work.code)
  )
    return 'clarification-needed';
  const delivery = record.delivery ?? record.work?.delivery;
  if (
    delivery?.pullRequest &&
    (!delivery.reconciled || delivery.attached === false || !delivery.announcement?.receipt)
  )
    return 'partially-delivered';
  if (record.work?.code || record.work?.result?.outcome === 'blocked') return 'blocked';
  const failure = record.continuation?.code ? record.continuation : record;
  if (failure.phase === 'blocked' || failure.phase === 'cancelled') return 'blocked';
  if (failure.retry) return 'retrying';
  return failure.phase ?? record.phase;
}
