/** Project only fixture-owned completion and permission evidence, without mutating it. */
export default function observeControl({
  number,
  configured,
  phase,
  sessions,
  conversation,
  evidence,
}) {
  const key = `:direct:github:issue:r_fixture:${number}`;
  const selected = sessions.filter((entry) => entry.key.toLowerCase().endsWith(key));
  const session = selected[0];
  const work = number === 4;
  const checks = {
    session: selected.length === 1,
    acknowledged: conversation?.acknowledgment?.status === 'published',
    assignment: work
      ? conversation?.assignmentResponse?.status === 'published'
      : conversation?.assignmentResponse?.status === 'withheld' &&
        conversation.assignmentResponse.reasonCode === 'github-notification-guided-waiting',
    turn:
      phase === 'implementation'
        ? conversation?.activeTurn === undefined &&
          conversation?.implementation?.status === 'delivery-pending'
        : work
          ? conversation?.activeTurn?.eventId !== 'assignment'
          : conversation?.activeTurn === undefined,
    owner: configured
      ? session?.owner?.actor?.type === 'agent' && session.owner.actor.id === 'notification-data'
      : session?.owner?.actor?.id !== 'notification-data',
    color: configured ? session?.color === 'purple' : !session?.color,
    group: configured ? session?.category === 'GitHub Issues' : !session?.category,
    model:
      evidence.strictMissCount === 0 &&
      evidence.successfulFixtureResponseCount === evidence.requestCount &&
      (phase === 'implementation'
        ? evidence.finalResponseCount === number + 1
        : evidence.finalResponseCount >= number),
  };
  return {
    ready: Object.values(checks).every(Boolean),
    number,
    phase,
    checks,
    lifecycle: {
      activeTurn: conversation?.activeTurn?.eventId,
      assignment: conversation?.assignmentResponse?.status,
      implementation: conversation?.implementation?.status,
    },
    persisted: { owner: session?.owner?.actor, color: session?.color, group: session?.category },
    model: {
      requests: evidence.requestCount,
      finals: evidence.finalResponseCount,
      misses: evidence.strictMissCount,
      successful: evidence.successfulFixtureResponseCount,
    },
  };
}
