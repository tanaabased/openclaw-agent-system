/** request templates keep direct entry and managed workflow submissions distinct. */
export default function assessmentSubmission(
  input: { id: string; previousResultDigest?: string } & (
    { entry: 'managed' } | { entry: 'direct'; target: string }
  ),
) {
  const request =
    input.entry === 'direct'
      ? {
          action: 'assessment' as const,
          operation: 'result' as const,
          id: input.id,
          target: input.target,
        }
      : { action: 'result' as const, id: input.id };
  return {
    request: {
      ...request,
      ...(input.previousResultDigest ? { previousResultDigest: input.previousResultDigest } : {}),
    },
    resultField: 'result' as const,
    refreshRequest:
      input.entry === 'direct'
        ? { action: 'assessment', operation: 'context', id: input.id, target: input.target }
        : { action: 'context', id: input.id },
  };
}
