import type { DispatchRecord } from './codex-dispatch-state.ts';
import type { codexDispatchNative } from './codex-dispatch-native.ts';
import workflowFailure from './workflow-failure.ts';

type Native = ReturnType<typeof codexDispatchNative>;

/** observe retained native custody without requiring a live checkout or authorizing another send. */
export default async function reconcileCodexCapacity(
  record: DispatchRecord,
  native: Pick<Native, 'find' | 'unsubmittedCreation'>,
  currentTurnId: string,
  now: number,
  discoverUnknown = false,
) {
  if (!record.request) return;
  const threadId =
    record.threadId ?? record.receiptThreadId ?? record.capacityObservation?.threadId;
  let code = 'dispatch-capacity-creation-unresolved';
  let observed: { threadId?: string; turnId?: string } = threadId ? { threadId } : {};
  let inactive = false;
  try {
    const found =
      threadId || discoverUnknown
        ? await native.find({
            sourceThreadId: record.sourceThreadId,
            prompt: record.request.prompt,
            createdAfter: record.createdAt,
            ...(threadId ? { threadId } : {}),
            observationOnly: true,
          })
        : undefined;
    if (found) {
      if (threadId && found.id !== threadId) throw new Error('dispatch-native-readback-diverged');
      observed = { threadId: found.id, ...(found.turnId ? { turnId: found.turnId } : {}) };
      inactive = Boolean(
        found.turnId && found.turnEnded && ['idle', 'notLoaded'].includes(found.status),
      );
      code = inactive
        ? 'dispatch-capacity-native-ended'
        : found.status === 'active'
          ? 'dispatch-capacity-native-active'
          : 'dispatch-capacity-native-not-ended';
      // fresh native activity adopts current reservation semantics until terminal proof.
      if (found.status === 'active') record.reservationVersion = 1;
    } else if (
      !threadId &&
      !record.clientThreadId &&
      !record.worktree &&
      !record.continuation?.attempt &&
      !record.continuation?.publicationAttempt &&
      !record.feedback?.events.some((event) => event.attempt)
    ) {
      const proof = await native.unsubmittedCreation(
        record.sourceThreadId,
        { createdAt: record.createdAt, turnId: record.preparationTurnId },
        currentTurnId,
      );
      if (proof) {
        inactive = true;
        observed = { turnId: proof.turnId };
        code = 'dispatch-capacity-never-submitted';
      }
    } else code = 'dispatch-capacity-native-missing';
  } catch (error) {
    code = workflowFailure(error, 'dispatch-capacity-observation-unavailable').code;
  }
  if (inactive) record.nativeInactive = true;
  else delete record.nativeInactive;
  record.capacityObservation = { at: now, code, ...observed };
  return record.capacityObservation;
}
