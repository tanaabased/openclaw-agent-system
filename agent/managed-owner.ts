interface ManagedOwnerRecord {
  threadId?: string;
  retired?: unknown;
  reset?: unknown;
}

/** retired/reset attempts are history; pending retirement or broken custody still owns work. */
export default function managedOwner<R extends ManagedOwnerRecord>(
  records: readonly R[],
  session: string,
  matches: (record: R) => boolean,
) {
  const matching = records.filter(matches);
  const current = matching.filter((record) => !record.retired && !record.reset);
  const callers = records.filter((record) => record.threadId === session);
  return {
    status:
      current.length > 1 || callers.length > 1
        ? ('ambiguous' as const)
        : current.length
          ? ('current' as const)
          : matching.length
            ? ('historical' as const)
            : ('absent' as const),
    owner: current.length === 1 ? current[0] : undefined,
    caller: callers.length === 1 ? callers[0] : undefined,
  };
}
