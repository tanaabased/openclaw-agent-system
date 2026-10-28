interface ManagedOwnerRecord {
  threadId?: string;
  retired?: unknown;
  reset?: unknown;
  supersededBy?: string;
  manualIssue?: { fresh?: boolean };
}

/** retired/reset attempts are history; pending retirement or broken custody still owns work. */
export default function managedOwner<R extends ManagedOwnerRecord>(
  records: readonly R[],
  session: string,
  matches: (record: R) => boolean,
) {
  const matching = records.filter(matches);
  const current = matching.filter(
    (record) => !record.retired && !record.reset && !record.supersededBy,
  );
  const callers = records.filter((record) => record.threadId === session);
  const primary = current.filter((record) => !record.manualIssue?.fresh);
  const selected = current.includes(callers[0]!)
    ? [callers[0]!]
    : primary.length
      ? primary
      : current;
  return {
    status:
      primary.length > 1 || selected.length > 1 || callers.length > 1
        ? ('ambiguous' as const)
        : current.length
          ? ('current' as const)
          : matching.length
            ? ('historical' as const)
            : ('absent' as const),
    owner: selected.length === 1 ? selected[0] : undefined,
    caller: callers.length === 1 ? callers[0] : undefined,
  };
}
