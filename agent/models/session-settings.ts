export interface SessionSettings {
  model?: string;
  effort?: string;
}

/** creation verifies intent; verified task custody is independent of mutable native settings. */
export default function sessionSettings(input: {
  requested: SessionSettings;
  observed: SessionSettings;
  creationVerified: boolean;
  requireInitialReadback?: boolean;
}) {
  const model = input.observed.model || undefined;
  const effort = input.observed.effort || undefined;
  const observed = { model, effort };
  const mismatch = input.creationVerified
    ? undefined
    : (['model', 'effort'] as const).find(
        (field) =>
          (input.requireInitialReadback || observed[field] !== undefined) &&
          observed[field] !== input.requested[field],
      );
  return {
    mismatch,
    effective: {
      status: model && effort ? ('verified' as const) : ('unverified' as const),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    },
  };
}
